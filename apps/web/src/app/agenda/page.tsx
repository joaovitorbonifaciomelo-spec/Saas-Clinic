import Link from 'next/link'
import type {
  AppointmentWithRelations,
  AvailabilityBlock,
  Patient,
  Professional,
  Service,
} from '@clinicas/shared'
import { apiFetch } from '../../lib/api'
import { requireActiveSession } from '../session'
import { localDateKey, rangeFor } from './agenda-time'
import { AgendaView } from './agenda-view'

export const dynamic = 'force-dynamic'

interface AgendaPageProps {
  searchParams: Promise<{ view?: string; date?: string; professional?: string }>
}

export default async function AgendaPage({ searchParams }: AgendaPageProps) {
  const params = await searchParams
  const { activeClinic } = await requireActiveSession()
  const timezone = activeClinic.clinicTimezone

  const view = params.view === 'week' ? 'week' : 'day'
  // "Hoje" e o hoje DA CLINICA, nao o do servidor nem o do navegador.
  const date = params.date ?? localDateKey(new Date(), timezone)
  const professionalId = params.professional ?? ''

  const { from, to, days } = rangeFor(date, view, timezone)

  const query = new URLSearchParams({ from, to })
  if (professionalId) query.set('professionalId', professionalId)

  const clinicId = activeClinic.clinicId

  // Em paralelo: a grade precisa das quatro listas antes de renderizar.
  const [appointments, professionals, services, patients] = await Promise.all([
    apiFetch<AppointmentWithRelations[]>(`/api/appointments?${query.toString()}`, { clinicId }),
    apiFetch<Professional[]>('/api/professionals', { clinicId }),
    apiFetch<Service[]>('/api/services?active=true', { clinicId }),
    apiFetch<Patient[]>('/api/patients', { clinicId }),
  ])

  // Disponibilidade so quando ha um profissional filtrado: sem filtro, a grade
  // mostra varios profissionais e um fundo unico nao significaria nada.
  let availability: AvailabilityBlock[] = []
  if (professionalId) {
    availability = await apiFetch<AvailabilityBlock[]>(
      `/api/professionals/${professionalId}/availability`,
      { clinicId },
    )
  }

  return (
    <main className="container wide">
      <div className="row">
        <h1>Agenda</h1>
        <span className="muted">
          {activeClinic.clinicName} · {timezone}
        </span>
      </div>

      <p className="muted">
        <Link href="/dashboard">Painel</Link> ·{' '}
        <Link href="/agenda/professionals">Profissionais</Link> ·{' '}
        <Link href="/agenda/services">Servicos</Link> · <Link href="/patients">Pacientes</Link>
      </p>

      <AgendaView
        view={view}
        date={date}
        days={days}
        timezone={timezone}
        professionalId={professionalId}
        appointments={appointments}
        professionals={professionals}
        services={services}
        patients={patients}
        availability={availability}
      />
    </main>
  )
}
