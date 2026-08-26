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

  /*
   * TUDO numa unica onda de requisicoes.
   *
   * A disponibilidade ficava numa segunda espera, depois do Promise.all — mas
   * ela so depende de `professionalId`, que vem da URL, nao do resultado das
   * outras chamadas. Era serializacao sem motivo, e cada ida e volta pelo
   * Funnel custa ~330ms medidos. Buscar junto tirou uma onda inteira da pagina.
   *
   * Sem filtro de profissional a grade mostra varios profissionais, e um fundo
   * de disponibilidade unico nao significaria nada — por isso a lista vazia.
   */
  const [appointments, professionals, services, patients, availability] = await Promise.all([
    apiFetch<AppointmentWithRelations[]>(`/api/appointments?${query.toString()}`, { clinicId }),
    apiFetch<Professional[]>('/api/professionals', { clinicId }),
    apiFetch<Service[]>('/api/services?active=true', { clinicId }),
    apiFetch<Patient[]>('/api/patients', { clinicId }),
    /*
     * Disponibilidade da clinica inteira: alimenta o fundo da grade quando ha
     * filtro E a marca "fora do horario" em cada cartao, sempre.
     *
     * TOLERANTE A API ANTIGA de proposito. A Vercel faz deploy automatico do
     * frontend no push, mas a imagem da VPS so e atualizada manualmente — entao
     * existe uma janela em que a tela nova conversa com a API velha, que ainda
     * nao tem esta rota. Sem o catch, a agenda inteira quebraria com 404 nessa
     * janela por causa de um enfeite. Aqui ela apenas deixa de mostrar as
     * marcas, e volta a mostra-las quando a API for atualizada.
     */
    apiFetch<AvailabilityBlock[]>('/api/professionals/availability', { clinicId }).catch(
      () => [] as AvailabilityBlock[],
    ),
  ])

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
