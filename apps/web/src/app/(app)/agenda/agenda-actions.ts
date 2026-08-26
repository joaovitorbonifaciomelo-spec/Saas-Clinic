'use server'

import { revalidatePath } from 'next/cache'
import {
  changeStatusSchema,
  createAppointmentSchema,
  createProfessionalSchema,
  createServiceSchema,
  replaceAvailabilitySchema,
  updateAppointmentSchema,
  type Appointment,
  type AppointmentWarning,
  type AvailabilityBlock,
  type Professional,
  type Service,
} from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'

export interface AgendaActionState {
  error: string | null
  /** Avisos devolvidos pelo 409, para a tela mostrar antes de confirmar. */
  warnings?: AppointmentWarning[]
  /** Identifica o conjunto de avisos exibido. Reenviado na confirmacao. */
  fingerprint?: string
  ok?: boolean
}

interface WarningsBody {
  error?: string
  message?: string
  warnings?: AppointmentWarning[]
  fingerprint?: string
}

/**
 * Traduz o 409 de avisos em estado de formulario.
 *
 * O fingerprint volta para a tela e e reenviado na confirmacao. Se a situacao
 * mudar entre as duas requisicoes, o servidor devolve um 409 novo com outro
 * fingerprint, e o usuario ve o aviso atualizado em vez de confirmar as cegas.
 */
function toActionState(error: unknown): AgendaActionState {
  if (error instanceof ApiError && error.status === 409 && error.payload) {
    const body = error.payload as WarningsBody
    if (body.error === 'APPOINTMENT_WARNINGS') {
      return {
        error: body.message ?? 'Este horario tem avisos.',
        warnings: body.warnings ?? [],
        fingerprint: body.fingerprint,
      }
    }
  }
  return { error: error instanceof Error ? error.message : 'Falha ao salvar.' }
}

function optionalString(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text === '' ? undefined : text
}

// ---------------------------------------------------------------------------
// Profissionais
// ---------------------------------------------------------------------------

export async function saveProfessionalAction(
  professionalId: string | null,
  _prev: AgendaActionState,
  formData: FormData,
): Promise<AgendaActionState> {
  const parsed = createProfessionalSchema.safeParse({
    name: formData.get('name'),
    specialty: formData.get('specialty'),
    active: formData.get('active') === 'on',
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }

  const { activeClinic } = await requireActiveSession()

  try {
    await apiFetch<Professional>(
      professionalId ? `/api/professionals/${professionalId}` : '/api/professionals',
      {
        method: professionalId ? 'PATCH' : 'POST',
        body: parsed.data,
        clinicId: activeClinic.clinicId,
      },
    )
  } catch (error) {
    return toActionState(error)
  }

  revalidatePath('/agenda/professionals')
  revalidatePath('/agenda')
  return { error: null, ok: true }
}

export async function saveAvailabilityAction(
  professionalId: string,
  _prev: AgendaActionState,
  formData: FormData,
): Promise<AgendaActionState> {
  // A grade chega como JSON: sao ate 7 dias x N faixas, e um campo por bloco
  // viraria um formulario ilegivel.
  const raw = formData.get('blocks')
  let blocks: unknown
  try {
    blocks = JSON.parse(typeof raw === 'string' ? raw : '[]')
  } catch {
    return { error: 'Grade de horarios invalida.' }
  }

  const parsed = replaceAvailabilitySchema.safeParse({ blocks })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Horarios invalidos.' }
  }

  const { activeClinic } = await requireActiveSession()

  try {
    await apiFetch<AvailabilityBlock[]>(`/api/professionals/${professionalId}/availability`, {
      method: 'PUT',
      body: parsed.data,
      clinicId: activeClinic.clinicId,
    })
  } catch (error) {
    return toActionState(error)
  }

  revalidatePath('/agenda/professionals')
  return { error: null, ok: true }
}

// ---------------------------------------------------------------------------
// Servicos
// ---------------------------------------------------------------------------

export async function saveServiceAction(
  serviceId: string | null,
  _prev: AgendaActionState,
  formData: FormData,
): Promise<AgendaActionState> {
  const priceRaw = optionalString(formData.get('priceReais'))
  const parsed = createServiceSchema.safeParse({
    name: formData.get('name'),
    durationMinutes: Number(formData.get('durationMinutes')),
    priceCents: priceRaw === undefined ? null : Math.round(Number(priceRaw) * 100),
    active: formData.get('active') === 'on',
  })
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }

  const { activeClinic } = await requireActiveSession()

  try {
    await apiFetch<Service>(serviceId ? `/api/services/${serviceId}` : '/api/services', {
      method: serviceId ? 'PATCH' : 'POST',
      body: parsed.data,
      clinicId: activeClinic.clinicId,
    })
  } catch (error) {
    return toActionState(error)
  }

  revalidatePath('/agenda/services')
  revalidatePath('/agenda')
  return { error: null, ok: true }
}

// ---------------------------------------------------------------------------
// Agendamentos
// ---------------------------------------------------------------------------

export async function saveAppointmentAction(
  appointmentId: string | null,
  _prev: AgendaActionState,
  formData: FormData,
): Promise<AgendaActionState> {
  const { activeClinic } = await requireActiveSession()

  const payload = {
    patientId: optionalString(formData.get('patientId')),
    professionalId: optionalString(formData.get('professionalId')),
    serviceId: optionalString(formData.get('serviceId')) ?? null,
    startsAt: optionalString(formData.get('startsAt')),
    endsAt: optionalString(formData.get('endsAt')),
    notes: formData.get('notes'),
    acknowledgedWarnings: optionalString(formData.get('acknowledgedWarnings')),
  }

  const parsed = appointmentId
    ? updateAppointmentSchema.safeParse(payload)
    : createAppointmentSchema.safeParse(payload)

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }
  }

  try {
    await apiFetch<Appointment>(
      appointmentId ? `/api/appointments/${appointmentId}` : '/api/appointments',
      {
        method: appointmentId ? 'PATCH' : 'POST',
        body: parsed.data,
        clinicId: activeClinic.clinicId,
      },
    )
  } catch (error) {
    return toActionState(error)
  }

  revalidatePath('/agenda')
  return { error: null, ok: true }
}

export async function changeAppointmentStatusAction(
  appointmentId: string,
  _prev: AgendaActionState,
  formData: FormData,
): Promise<AgendaActionState> {
  const parsed = changeStatusSchema.safeParse({ status: formData.get('status') })
  if (!parsed.success) return { error: 'Status invalido.' }

  const { activeClinic } = await requireActiveSession()

  try {
    await apiFetch<Appointment>(`/api/appointments/${appointmentId}/status`, {
      method: 'PATCH',
      body: parsed.data,
      clinicId: activeClinic.clinicId,
    })
  } catch (error) {
    return toActionState(error)
  }

  revalidatePath('/agenda')
  return { error: null, ok: true }
}
