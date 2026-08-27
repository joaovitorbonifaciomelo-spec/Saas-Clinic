import Link from 'next/link'
import {
  APPOINTMENT_STATUS_LABELS,
  selectNextAppointment,
  type AppointmentWithRelations,
  type Patient,
} from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { loadForActiveClinic } from '../../session'
import { PerfMeta } from '../../ui/perf-meta'
import { formatDateLabel, localDateKey, localTimeLabel } from '../agenda/agenda-time'
import { formatPhone, initials } from '../../ui/format'
import { IconCake, IconEdit, IconPhone, IconPlus, IconShield } from '../../ui/icons'
import { PatientList } from './patient-list'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ p?: string; q?: string }>
}

/**
 * Master-detail numa rota so.
 *
 * O paciente selecionado vive na query string (`?p=<id>`), nao numa rota
 * aninhada. Trocar de paciente e uma navegacao client-side que mantem o shell e
 * a lista montados — o fluxo antigo (lista -> pagina inteira -> voltar) sumiu —
 * e a URL continua compartilhavel e recarregavel.
 */
export default async function PatientsPage({ searchParams }: PageProps) {
  const params = await searchParams
  /*
   * O historico so espera a lista quando NAO ha paciente na URL.
   *
   * Antes eram sempre tres ondas em serie: me -> pacientes -> agendamentos. Mas
   * o id do paciente selecionado quase sempre vem da propria URL (`?p=`), e nesse
   * caso o historico nao depende da lista em nada — a espera era invencao nossa.
   * So o primeiro acesso, sem `?p=`, precisa saber quem e o primeiro da lista.
   *
   * Vale a onda economizada: a mediana do Funnel e 246ms, mas o p90 e 853ms.
   */
  const historicoDe = (clinicId: string, patientId: string) =>
    apiFetch<AppointmentWithRelations[]>(`/api/appointments?patientId=${patientId}`, {
      clinicId,
    }).catch((error: unknown) => {
      // Historico e complemento: se falhar, a ficha ainda serve.
      if (!(error instanceof ApiError)) throw error
      return [] as AppointmentWithRelations[]
    })

  const { session, data } = await loadForActiveClinic(async (clinicId) => {
    const [patients, historicoPreCarregado] = await Promise.all([
      apiFetch<Patient[]>('/api/patients', { clinicId }),
      params.p ? historicoDe(clinicId, params.p) : Promise.resolve(null),
    ])
    return { clinicId, patients, historicoPreCarregado }
  })
  const { clinicId, patients, historicoPreCarregado } = data
  const timezone = session.activeClinic.clinicTimezone

  // Sem selecao explicita, abre o primeiro: painel vazio nao ajuda ninguem.
  const selectedId = params.p ?? patients[0]?.id
  const selected = patients.find((p) => p.id === selectedId)

  let appointments: AppointmentWithRelations[] = []
  if (selected) {
    /*
     * O pre-carregado so vale se o `?p=` era mesmo de um paciente desta clinica.
     * Se o id da URL nao existir na lista, ele foi buscado a toa (a API devolve
     * vazio pelo RLS) e caimos no caminho normal do primeiro da lista.
     */
    appointments =
      historicoPreCarregado !== null && selected.id === params.p
        ? historicoPreCarregado
        : await historicoDe(clinicId, selected.id)
  }

  const proxima = selectNextAppointment(appointments)
  const historico = [...appointments].sort((a, b) => b.startsAt.localeCompare(a.startsAt))

  return (
    <div className="content master-detail">
      <PerfMeta />
      <PatientList patients={patients} selectedId={selected?.id} query={params.q ?? ''} />

      {!selected ? (
        <section className="card">
          <p className="empty">
            Nenhum paciente cadastrado ainda.
            <br />
            <Link href="/patients/new">Cadastrar o primeiro</Link>
          </p>
        </section>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="card">
            <div className="patient-head">
              <span className="avatar lg">{initials(selected.name)}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h1 style={{ fontSize: 20 }}>{selected.name}</h1>
                <div className="patient-contact">
                  <span>
                    <IconPhone /> {formatPhone(selected.phone)}
                  </span>
                  <span>
                    <IconCake />{' '}
                    {selected.birthDate
                      ? formatDateLabel(selected.birthDate)
                      : 'Nascimento não informado'}
                  </span>
                  <span>
                    <IconShield /> {selected.insuranceProvider ?? 'Sem convênio'}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {/*
                   prefetch desligado: sao rotas force-dynamic, entao o prefetch do
                   Next nao busca um shell estatico — ele renderiza a rota inteira
                   no servidor. Medido: abrir Pacientes disparava 4 requisicoes
                   extras (as duas rotas, duas vezes cada) que ninguem pediu e que
                   competiam com a navegacao de verdade.
                */}
                <Link
                  href={`/patients/${selected.id}/edit`}
                  prefetch={false}
                  className="btn secondary sm"
                >
                  <IconEdit /> Editar paciente
                </Link>
                <Link
                  href={`/agenda?date=${localDateKey(new Date(), timezone)}&novo=1&patient=${selected.id}`}
                  className="btn sm"
                >
                  <IconPlus /> Novo agendamento
                </Link>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Próxima consulta</h2>
            </div>
            {proxima ? (
              <div className="next-appt">
                <div className="next-date">
                  <span className="next-day tabular">
                    {localDateKey(new Date(proxima.startsAt), timezone).split('-')[2]}
                  </span>
                  <span className="next-month">
                    {formatDateLabel(localDateKey(new Date(proxima.startsAt), timezone)).slice(
                      3,
                      5,
                    )}
                  </span>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 570 }}>
                    {formatDateLabel(localDateKey(new Date(proxima.startsAt), timezone))} às{' '}
                    {localTimeLabel(proxima.startsAt, timezone)}
                  </div>
                  <div className="faint">
                    {proxima.professionalName}
                    {proxima.serviceName ? ` · ${proxima.serviceName}` : ''}
                  </div>
                </div>
                <span className={`badge ${proxima.status}`}>
                  {APPOINTMENT_STATUS_LABELS[proxima.status]}
                </span>
              </div>
            ) : (
              <p className="empty">Nenhuma consulta futura agendada.</p>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Histórico de agendamentos</h2>
              <span className="faint tabular">{historico.length}</span>
            </div>
            {historico.length === 0 ? (
              <p className="empty">Nenhum agendamento registrado.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Horário</th>
                      <th>Profissional</th>
                      <th>Serviço</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historico.map((a) => (
                      <tr key={a.id}>
                        <td className="tabular">
                          {formatDateLabel(localDateKey(new Date(a.startsAt), timezone))}
                        </td>
                        <td className="tabular">{localTimeLabel(a.startsAt, timezone)}</td>
                        <td>{a.professionalName}</td>
                        <td className="muted">{a.serviceName ?? '—'}</td>
                        <td>
                          <span className={`badge ${a.status}`}>
                            {APPOINTMENT_STATUS_LABELS[a.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
