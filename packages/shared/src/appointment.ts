import { z } from 'zod'

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'awaiting_confirmation',
  'confirmed',
  'reschedule_requested',
  'cancelled',
  'completed',
  'no_show',
] as const

export const appointmentStatusSchema = z.enum(APPOINTMENT_STATUSES)
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: 'Agendado',
  awaiting_confirmation: 'Aguardando confirmacao',
  confirmed: 'Confirmado',
  reschedule_requested: 'Reagendamento solicitado',
  cancelled: 'Cancelado',
  completed: 'Realizado',
  no_show: 'Falta',
}

/**
 * Transicoes permitidas na v0.1.
 *
 * Modelado sobre o fluxo REAL da recepcao, nao sobre uma cadeia idealizada:
 *   - o paciente comparece mesmo sem ter confirmado antes, entao `scheduled`
 *     alcanca `completed` e `no_show` diretamente;
 *   - a confirmacao por telefone acontece na hora, sem passo intermediario;
 *   - o pedido de reagendamento chega antes de qualquer confirmacao.
 *
 * `completed`, `no_show` e `cancelled` sao TERMINAIS: array vazio, nao ausencia
 * de chave — a diferenca importa para quem le o mapa. Reabrir um terminal sera
 * uma regra nova e explicita, nunca um efeito colateral.
 *
 * Espelhado no trigger `enforce_appointment_status_transition` do banco. Se um
 * dos dois mudar, o outro muda junto.
 */
export const APPOINTMENT_STATUS_TRANSITIONS: Record<
  AppointmentStatus,
  readonly AppointmentStatus[]
> = {
  scheduled: [
    'awaiting_confirmation',
    'confirmed',
    'reschedule_requested',
    'completed',
    'no_show',
    'cancelled',
  ],
  awaiting_confirmation: ['confirmed', 'reschedule_requested', 'completed', 'no_show', 'cancelled'],
  confirmed: ['reschedule_requested', 'completed', 'no_show', 'cancelled'],
  reschedule_requested: ['scheduled', 'awaiting_confirmation', 'cancelled'],
  cancelled: [],
  completed: [],
  no_show: [],
}

export const TERMINAL_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'cancelled',
  'completed',
  'no_show',
]

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_STATUS_TRANSITIONS[from].includes(to)
}

export function isTerminalStatus(status: AppointmentStatus): boolean {
  return TERMINAL_APPOINTMENT_STATUSES.includes(status)
}

export const NOTES_MAX = 2000

/**
 * `startsAt` e `endsAt` sao instantes absolutos em ISO-8601 com offset.
 * O banco guarda `timestamptz`; o recorte de dia e semana usa o fuso da clinica,
 * nunca o do navegador.
 */
const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'Informe um instante ISO-8601 com fuso.' })

const appointmentBase = z.object({
  patientId: z.uuid(),
  professionalId: z.uuid(),
  serviceId: z.uuid().nullable().optional(),
  startsAt: instantSchema,
  endsAt: instantSchema,
  notes: z
    .string()
    .trim()
    .max(NOTES_MAX)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  /**
   * Confirmacao consciente dos avisos: o fingerprint EXATO que o 409 devolveu.
   * Nao existe boolean generico — ver `AppointmentWarningsError`.
   */
  acknowledgedWarnings: z.string().length(64).optional(),
})

/**
 * `clinic_id` e `created_by` NAO estao no payload por construcao. O tenant vem
 * do header validado pelo guard e o autor vem do JWT. Se estivessem aqui, o
 * cliente escolheria de quem e o agendamento.
 */
export const createAppointmentSchema = appointmentBase.refine(
  (value) => value.endsAt > value.startsAt,
  { message: 'O fim deve ser depois do inicio.', path: ['endsAt'] },
)

export const updateAppointmentSchema = appointmentBase
  .partial()
  .refine(
    (value) =>
      value.startsAt === undefined || value.endsAt === undefined || value.endsAt > value.startsAt,
    { message: 'O fim deve ser depois do inicio.', path: ['endsAt'] },
  )

export const changeStatusSchema = z.object({ status: appointmentStatusSchema })

export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>
export type UpdateAppointmentInput = z.infer<typeof updateAppointmentSchema>
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>

export interface Appointment {
  id: string
  clinicId: string
  patientId: string
  professionalId: string
  serviceId: string | null
  startsAt: string
  endsAt: string
  status: AppointmentStatus
  notes: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** Agendamento com os nomes ja resolvidos, para a grade nao fazer N+1. */
export interface AppointmentWithRelations extends Appointment {
  patientName: string
  professionalName: string
  serviceName: string | null
}

// ---------------------------------------------------------------------------
// Avisos (nao bloqueiam — exigem confirmacao consciente)
// ---------------------------------------------------------------------------

export interface OverlapWarning {
  type: 'overlap'
  appointments: Array<{
    id: string
    startsAt: string
    endsAt: string
    status: AppointmentStatus
    patientName: string
  }>
}

export interface OutsideAvailabilityWarning {
  type: 'outside_availability'
  weekday: number
  /** Blocos ativos do profissional naquele dia. Vazio = nao atende nesse dia. */
  availability: Array<{ startTime: string; endTime: string }>
}

export type AppointmentWarning = OverlapWarning | OutsideAvailabilityWarning

/**
 * Corpo do 409.
 *
 * `fingerprint` identifica ESTE conjunto de avisos. Para prosseguir, o cliente
 * reenvia o mesmo valor em `acknowledgedWarnings`; o servidor recalcula os
 * avisos e so aceita se o fingerprint ainda bater. Se um novo conflito surgir
 * entre as duas requisicoes, o fingerprint muda e o usuario ve o aviso novo em
 * vez de autorizar as cegas algo que nunca lhe foi mostrado.
 */
export interface AppointmentWarningsError {
  statusCode: 409
  error: 'APPOINTMENT_WARNINGS'
  message: string
  fingerprint: string
  warnings: AppointmentWarning[]
}

export const APPOINTMENT_WARNINGS_ERROR = 'APPOINTMENT_WARNINGS'

/**
 * A "proxima consulta" do paciente.
 *
 * Exclui TODOS os estados terminais, nao apenas `cancelled`. Um agendamento
 * `completed` ou `no_show` ja teve desfecho — mesmo que a data ainda esteja no
 * futuro, ele nao e a proxima consulta de ninguem.
 *
 * O filtro anterior olhava so para `cancelled`. O teste manual nao pegou porque
 * ali o realizado estava no passado e caia fora pelo corte de data; o smoke em
 * producao, marcando como realizado um horario futuro, expos a falha.
 */
export function selectNextAppointment<T extends { status: AppointmentStatus; startsAt: string }>(
  appointments: readonly T[],
  now: Date = new Date(),
): T | undefined {
  return appointments
    .filter((a) => !isTerminalStatus(a.status) && new Date(a.startsAt) >= now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]
}
