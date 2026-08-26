import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import {
  APPOINTMENT_WARNINGS_ERROR,
  canTransition,
  type Appointment,
  type AppointmentStatus,
  type AppointmentWarning,
  type AppointmentWithRelations,
  type CreateAppointmentInput,
  type UpdateAppointmentInput,
} from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'
import { fingerprintWarnings } from './appointment-warnings'

interface AppointmentRow {
  id: string
  clinic_id: string
  patient_id: string
  professional_id: string
  service_id: string | null
  starts_at: string
  ends_at: string
  status: AppointmentStatus
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface AppointmentRowWithRelations extends AppointmentRow {
  patients: { name: string } | null
  professionals: { name: string } | null
  services: { name: string } | null
}

const COLUMNS =
  'id, clinic_id, patient_id, professional_id, service_id, starts_at, ends_at, status, notes, created_by, created_at, updated_at'
const COLUMNS_WITH_RELATIONS = `${COLUMNS}, patients ( name ), professionals ( name ), services ( name )`

function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    patientId: row.patient_id,
    professionalId: row.professional_id,
    serviceId: row.service_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toAppointmentWithRelations(row: AppointmentRowWithRelations): AppointmentWithRelations {
  return {
    ...toAppointment(row),
    patientName: row.patients?.name ?? '',
    professionalName: row.professionals?.name ?? '',
    serviceName: row.services?.name ?? null,
  }
}

export interface ListAppointmentsFilter {
  from?: string
  to?: string
  professionalId?: string
  patientId?: string
}

@Injectable()
export class AppointmentsService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  async list(
    clinicId: string,
    filter: ListAppointmentsFilter,
  ): Promise<AppointmentWithRelations[]> {
    let query = this.supabase
      .from('appointments')
      .select(COLUMNS_WITH_RELATIONS)
      .eq('clinic_id', clinicId)

    // Intervalo semiaberto [from, to): um agendamento que comeca exatamente as
    // 00:00 do dia seguinte pertence ao dia seguinte, nao aos dois.
    if (filter.from) query = query.gte('starts_at', filter.from)
    if (filter.to) query = query.lt('starts_at', filter.to)
    if (filter.professionalId) query = query.eq('professional_id', filter.professionalId)
    if (filter.patientId) query = query.eq('patient_id', filter.patientId)

    const { data, error } = await query.order('starts_at', { ascending: true })
    if (error) throw mapPostgrestError(error)

    return (data as unknown as AppointmentRowWithRelations[]).map(toAppointmentWithRelations)
  }

  /**
   * Ausencia tratada aqui, explicitamente. Agendamento inexistente e agendamento
   * de outro tenant produzem o mesmo 404, com o mesmo corpo.
   */
  async findById(clinicId: string, id: string): Promise<AppointmentWithRelations> {
    const { data, error } = await this.supabase
      .from('appointments')
      .select(COLUMNS_WITH_RELATIONS)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Agendamento nao encontrado.')

    return toAppointmentWithRelations(data as unknown as AppointmentRowWithRelations)
  }

  // -------------------------------------------------------------------------
  // Avisos
  // -------------------------------------------------------------------------

  /**
   * Sobreposicao com outros agendamentos do MESMO profissional.
   *
   * Dois intervalos se sobrepoem quando cada um comeca antes do outro terminar.
   * Cancelados sao ignorados: o horario esta livre de fato. Ao editar, o proprio
   * agendamento sai da conta — senao ele conflitaria consigo mesmo.
   */
  private async findOverlaps(
    clinicId: string,
    professionalId: string,
    startsAt: string,
    endsAt: string,
    excludeId?: string,
  ): Promise<AppointmentWarning[]> {
    let query = this.supabase
      .from('appointments')
      .select('id, starts_at, ends_at, status, patients ( name )')
      .eq('clinic_id', clinicId)
      .eq('professional_id', professionalId)
      .neq('status', 'cancelled')
      .lt('starts_at', endsAt)
      .gt('ends_at', startsAt)

    if (excludeId) query = query.neq('id', excludeId)

    const { data, error } = await query
    if (error) throw mapPostgrestError(error)

    const rows = data as unknown as Array<{
      id: string
      starts_at: string
      ends_at: string
      status: AppointmentStatus
      patients: { name: string } | null
    }>

    if (rows.length === 0) return []

    return [
      {
        type: 'overlap',
        appointments: rows.map((row) => ({
          id: row.id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          status: row.status,
          patientName: row.patients?.name ?? '',
        })),
      },
    ]
  }

  /**
   * Horario fora da disponibilidade declarada do profissional.
   *
   * O dia da semana e as horas sao lidos no FUSO DA CLINICA, nao no do servidor:
   * a disponibilidade e declarada em horario local ("segunda, 08:00-12:00") e
   * comparar contra UTC deslocaria a janela.
   */
  private async findAvailabilityWarning(
    clinicId: string,
    professionalId: string,
    startsAt: string,
    endsAt: string,
    timezone: string,
  ): Promise<AppointmentWarning[]> {
    const { weekday, time: startLocal } = localParts(startsAt, timezone)
    const { time: endLocal } = localParts(endsAt, timezone)

    const { data, error } = await this.supabase
      .from('professional_availability')
      .select('weekday, start_time, end_time')
      .eq('clinic_id', clinicId)
      .eq('professional_id', professionalId)
      .eq('weekday', weekday)
      .eq('active', true)

    if (error) throw mapPostgrestError(error)

    const blocks = (data as unknown as Array<{ start_time: string; end_time: string }>).map(
      (block) => ({ startTime: block.start_time, endTime: block.end_time }),
    )

    // Cabe se algum bloco contem o intervalo inteiro. Um agendamento que
    // atravessa a pausa do almoco fica fora, e isso e um aviso legitimo.
    const fits = blocks.some((block) => startLocal >= block.startTime && endLocal <= block.endTime)
    if (fits) return []

    return [{ type: 'outside_availability', weekday, availability: blocks }]
  }

  private async collectWarnings(
    clinicId: string,
    professionalId: string,
    startsAt: string,
    endsAt: string,
    timezone: string,
    excludeId?: string,
  ): Promise<AppointmentWarning[]> {
    const [overlaps, availability] = await Promise.all([
      this.findOverlaps(clinicId, professionalId, startsAt, endsAt, excludeId),
      this.findAvailabilityWarning(clinicId, professionalId, startsAt, endsAt, timezone),
    ])
    return [...overlaps, ...availability]
  }

  /**
   * Recalcula os avisos e decide se a operacao pode seguir.
   *
   * O cliente confirma um conjunto ESPECIFICO de avisos, identificado pelo
   * fingerprint que recebeu no 409 anterior. Aqui os avisos sao calculados de
   * novo: se algo mudou nesse meio-tempo, o hash nao bate e a confirmacao e
   * recusada com um 409 novo — o usuario ve o aviso atualizado em vez de
   * autorizar as cegas.
   */
  private async guardWarnings(
    clinicId: string,
    professionalId: string,
    startsAt: string,
    endsAt: string,
    timezone: string,
    acknowledged: string | undefined,
    excludeId?: string,
  ): Promise<void> {
    const warnings = await this.collectWarnings(
      clinicId,
      professionalId,
      startsAt,
      endsAt,
      timezone,
      excludeId,
    )
    if (warnings.length === 0) return

    const fingerprint = fingerprintWarnings(warnings)
    if (acknowledged === fingerprint) return

    throw new ConflictException({
      statusCode: 409,
      error: APPOINTMENT_WARNINGS_ERROR,
      message:
        acknowledged === undefined
          ? 'Este horario tem avisos. Revise antes de confirmar.'
          : 'A situacao mudou desde o aviso anterior. Revise os avisos atuais.',
      fingerprint,
      warnings,
    })
  }

  // -------------------------------------------------------------------------
  // Escrita
  // -------------------------------------------------------------------------

  async create(
    clinicId: string,
    userId: string,
    timezone: string,
    input: CreateAppointmentInput,
  ): Promise<Appointment> {
    await this.guardWarnings(
      clinicId,
      input.professionalId,
      input.startsAt,
      input.endsAt,
      timezone,
      input.acknowledgedWarnings,
    )

    const { data, error } = await this.supabase
      .from('appointments')
      .insert({
        // clinic_id vem do guard; created_by vem do JWT. Nenhum dos dois do corpo.
        clinic_id: clinicId,
        created_by: userId,
        patient_id: input.patientId,
        professional_id: input.professionalId,
        service_id: input.serviceId ?? null,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        notes: input.notes ?? null,
      })
      .select(COLUMNS)
      .single()

    if (error) throw mapPostgrestError(error)
    return toAppointment(data as unknown as AppointmentRow)
  }

  async update(
    clinicId: string,
    id: string,
    timezone: string,
    input: UpdateAppointmentInput,
  ): Promise<Appointment> {
    const current = await this.findById(clinicId, id)

    const professionalId = input.professionalId ?? current.professionalId
    const startsAt = input.startsAt ?? current.startsAt
    const endsAt = input.endsAt ?? current.endsAt

    // Reavaliar os avisos so faz sentido se o que os determina mudou.
    const scheduleChanged =
      professionalId !== current.professionalId ||
      startsAt !== current.startsAt ||
      endsAt !== current.endsAt

    if (scheduleChanged) {
      await this.guardWarnings(
        clinicId,
        professionalId,
        startsAt,
        endsAt,
        timezone,
        input.acknowledgedWarnings,
        id,
      )
    }

    const patch: Record<string, unknown> = {}
    if (input.patientId !== undefined) patch.patient_id = input.patientId
    if (input.professionalId !== undefined) patch.professional_id = input.professionalId
    if (input.serviceId !== undefined) patch.service_id = input.serviceId ?? null
    if (input.startsAt !== undefined) patch.starts_at = input.startsAt
    if (input.endsAt !== undefined) patch.ends_at = input.endsAt
    if (input.notes !== undefined) patch.notes = input.notes ?? null

    if (Object.keys(patch).length === 0) return current

    const { data, error } = await this.supabase
      .from('appointments')
      .update(patch)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .select(COLUMNS)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Agendamento nao encontrado.')

    return toAppointment(data as unknown as AppointmentRow)
  }

  /**
   * A transicao e validada aqui para dar erro legivel, e de novo pelo trigger no
   * banco. A checagem da API pode ser contornada; a do banco nao.
   */
  async changeStatus(
    clinicId: string,
    id: string,
    status: AppointmentStatus,
  ): Promise<Appointment> {
    const current = await this.findById(clinicId, id)

    if (current.status === status) return current

    if (!canTransition(current.status, status)) {
      throw new ConflictException(`Transicao invalida: ${current.status} nao pode virar ${status}.`)
    }

    const { data, error } = await this.supabase
      .from('appointments')
      .update({ status })
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .select(COLUMNS)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Agendamento nao encontrado.')

    return toAppointment(data as unknown as AppointmentRow)
  }
}

/**
 * Dia da semana (0-6) e hora local (HH:MM:SS) de um instante, num fuso IANA.
 *
 * Usa Intl em vez de aritmetica de offset porque so ele acerta horario de verao
 * e mudancas historicas de fuso.
 */
export function localParts(iso: string, timezone: string): { weekday: number; time: string } {
  const date = new Date(iso)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'

  const weekdayNames: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }

  // Intl pode devolver "24" para meia-noite em hourCycle h23/h24; normalizamos.
  const hour = get('hour') === '24' ? '00' : get('hour')

  return {
    weekday: weekdayNames[get('weekday')] ?? 0,
    time: `${hour}:${get('minute')}:${get('second')}`,
  }
}
