import Link from 'next/link'
import {
  APPOINTMENT_STATUS_LABELS,
  type AppointmentWithRelations,
  type Page,
  type Professional,
  type TaskListItem,
} from '@clinicas/shared'
import { apiFetch } from '../../../lib/api'
import { getActiveSession } from '../../session'
import { localDateKey, localTimeLabel, rangeFor } from '../agenda/agenda-time'
import { prazoCurto } from '../pendencias/pd-format'
import { fullDateLabel, initials, minutesBetween } from '../../ui/format'
import {
  IconAlert,
  IconCalendar,
  IconCheck,
  IconClock,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStethoscope,
  IconTag,
  IconUsers,
} from '../../ui/icons'
import { PerfMeta } from '../../ui/perf-meta'
import { TodayTimeline } from './today-timeline'

export const dynamic = 'force-dynamic'

export default async function TodayPage() {
  const { activeClinic } = await getActiveSession()
  const clinicId = activeClinic.clinicId
  const timezone = activeClinic.clinicTimezone

  const today = localDateKey(new Date(), timezone)
  const { from, to } = rangeFor(today, 'day', timezone)

  /*
   * Ate 3 pendencias abertas em "Precisa da sua atencao": Atrasadas primeiro,
   * Hoje depois. limit=4 em cada busca (nao 3) e de proposito — o item extra,
   * se vier, so serve para saber que ha mais sem precisar contar o total.
   * Nenhuma chamada extra so para contagem: a API nao promete `/tasks/counts`,
   * e inventar um numero que pode ficar errado e pior que nao mostrar nenhum.
   */
  const PENDENCIAS_LIMITE = 3
  const PENDENCIAS_BUSCA = PENDENCIAS_LIMITE + 1

  const [appointments, professionals, pendenciasAtrasadas, pendenciasHoje] = await Promise.all([
    apiFetch<AppointmentWithRelations[]>(`/api/appointments?from=${from}&to=${to}`, { clinicId }),
    apiFetch<Professional[]>('/api/professionals?active=true', { clinicId }),
    apiFetch<Page<TaskListItem>>(
      `/api/tasks?limit=${PENDENCIAS_BUSCA}&status=open&due=overdue&assignment=any`,
      { clinicId },
    ),
    apiFetch<Page<TaskListItem>>(
      `/api/tasks?limit=${PENDENCIAS_BUSCA}&status=open&due=today&assignment=any`,
      { clinicId },
    ),
  ])

  const pendenciasAtrasadasMostradas = pendenciasAtrasadas.items.slice(0, PENDENCIAS_LIMITE)
  const vagasRestantes = PENDENCIAS_LIMITE - pendenciasAtrasadasMostradas.length
  const pendenciasHojeMostradas = pendenciasHoje.items.slice(0, vagasRestantes)
  const pendenciasAtencao = [
    ...pendenciasAtrasadasMostradas.map((t) => ({ tarefa: t, atrasada: true })),
    ...pendenciasHojeMostradas.map((t) => ({ tarefa: t, atrasada: false })),
  ]
  const temMaisPendencias =
    pendenciasAtrasadas.items.length > pendenciasAtrasadasMostradas.length ||
    pendenciasHoje.items.length > pendenciasHojeMostradas.length

  const ativos = appointments.filter((a) => a.status !== 'cancelled')
  const count = (status: string) => appointments.filter((a) => a.status === status).length

  /*
   * Indicadores derivados APENAS do que ja temos. Nao ha "novas conversas",
   * "pendencias" nem faturamento aqui: numero inventado numa tela operacional e
   * pior do que numero ausente, porque alguem toma decisao com ele.
   */
  const kpis = [
    { label: 'Consultas hoje', value: ativos.length, Icon: IconCalendar, tone: 'info' },
    { label: 'Confirmadas', value: count('confirmed'), Icon: IconCheck, tone: 'confirmed' },
    {
      label: 'Aguardando confirmação',
      value: count('awaiting_confirmation'),
      Icon: IconClock,
      tone: 'awaiting',
    },
    {
      label: 'Reagendamento solicitado',
      value: count('reschedule_requested'),
      Icon: IconRefresh,
      tone: 'reschedule',
    },
    { label: 'Realizadas', value: count('completed'), Icon: IconCheck, tone: 'completed' },
    { label: 'Faltas', value: count('no_show'), Icon: IconAlert, tone: 'noshow' },
  ]

  const precisaAtencao = appointments.filter(
    (a) => a.status === 'awaiting_confirmation' || a.status === 'reschedule_requested',
  )

  return (
    <div className="content">
      <PerfMeta />
      <div className="page-head">
        <div>
          <h1>Hoje</h1>
          <p className="page-sub">{fullDateLabel(today)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/patients?novo=1" className="btn secondary">
            <IconUsers size={15} /> Novo paciente
          </Link>
          <Link href={`/agenda?date=${today}&novo=1`} className="btn">
            <IconPlus /> Novo agendamento
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="kpis">
          {kpis.map(({ label, value, Icon, tone }) => (
            <div className="kpi" key={label}>
              <span className={`kpi-icon tone-${tone}`}>
                <Icon size={16} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="kpi-value tabular">{value}</div>
                <div className="kpi-label">{label}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="today-grid">
        {/*
          As duas colunas empilham cards. Antes a esquerda era uma secao solta e
          a direita uma pilha: com poucas consultas, a esquerda terminava no meio
          da tela e a direita seguia sozinha por mais 300px.
        */}
        <div className="today-col">
          <section className="card">
            <div className="card-head">
              <h2>Agenda de hoje</h2>
              <Link href={`/agenda?date=${today}`} className="btn ghost sm">
                Ver agenda completa →
              </Link>
            </div>
            <TodayTimeline appointments={appointments} timezone={timezone} />
          </section>

          {/*
            Acoes rapidas: SO navegacao para telas que ja existem. Nenhum
            contador, nenhum aviso, nenhum modulo futuro disfarcado de atalho —
            atalho para tela inexistente e promessa quebrada no clique.
          */}
          <section className="card">
            <div className="card-head">
              <h2>Ações rápidas</h2>
            </div>
            <ul className="quick-actions">
              <li>
                <Link href={`/agenda?date=${today}&novo=1`} className="quick-action">
                  <IconPlus size={16} /> Novo agendamento
                </Link>
              </li>
              <li>
                <Link href="/patients/new" className="quick-action">
                  <IconUsers size={16} /> Novo paciente
                </Link>
              </li>
              <li>
                <Link href={`/agenda?date=${today}&view=week`} className="quick-action">
                  <IconCalendar size={16} /> Agenda da semana
                </Link>
              </li>
              <li>
                <Link href="/agenda/professionals" className="quick-action">
                  <IconStethoscope size={16} /> Profissionais
                </Link>
              </li>
              <li>
                <Link href="/patients" className="quick-action">
                  <IconSearch size={16} /> Buscar paciente
                </Link>
              </li>
              <li>
                <Link href="/agenda/services" className="quick-action">
                  <IconTag size={16} /> Serviços
                </Link>
              </li>
            </ul>
          </section>
        </div>

        <div className="today-col">
          <section className="card">
            <div className="card-head">
              <h2>Precisa da sua atenção</h2>
              {precisaAtencao.length > 0 ? (
                <span className="badge warn plain tabular">{precisaAtencao.length}</span>
              ) : null}
            </div>
            {precisaAtencao.length === 0 && pendenciasAtencao.length === 0 ? (
              /*
                Faixa, nao card vazio. Um bloco de 100px de altura centralizando
                "nada pendente" gastava a mesma area de uma lista cheia para
                dizer que nao ha lista — e empurrava o resto da coluna para
                baixo. Ausencia de pendencia e boa noticia e cabe em uma linha.
              */
              <div className="attn-ok">
                <span className="attn-ok-icon">
                  <IconCheck size={17} />
                </span>
                <span>
                  <span className="attn-ok-title">Tudo em dia</span>
                  <span className="attn-ok-sub">Nenhuma ação pendente para hoje.</span>
                </span>
              </div>
            ) : (
              <>
                {precisaAtencao.length > 0 ? (
                  <ul className="plain-list">
                    {precisaAtencao.map((a) => (
                      <li key={a.id}>
                        <Link href={`/agenda?date=${today}`} className="attn-row">
                          <span className={`dot ${a.status}`} />
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <span className="attn-name">{a.patientName}</span>
                            <span className="faint">
                              {localTimeLabel(a.startsAt, timezone)} · {a.professionalName}
                            </span>
                          </span>
                          <span className={`badge ${a.status}`}>
                            {APPOINTMENT_STATUS_LABELS[a.status]}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {pendenciasAtencao.length > 0 ? (
                  <ul
                    className="plain-list"
                    style={precisaAtencao.length > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
                  >
                    {pendenciasAtencao.map(({ tarefa, atrasada }) => (
                      <li key={tarefa.id}>
                        <Link href="/pendencias" className="attn-row">
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <span className="attn-name">{tarefa.title}</span>
                            <span className="faint">
                              <span className={atrasada ? 'attn-prazo-atrasado' : undefined}>
                                {prazoCurto(tarefa.dueAt, timezone)}
                              </span>
                              {tarefa.assignee ? ` · ${tarefa.assignee.displayName ?? 'Sem nome'}` : ''}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {temMaisPendencias ? (
                  <div className="attn-mais">
                    <Link href="/pendencias" className="btn ghost sm">
                      Ver todas as pendências →
                    </Link>
                  </div>
                ) : null}
              </>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Profissionais ativos</h2>
              <span className="faint tabular">{professionals.length}</span>
            </div>
            {professionals.length === 0 ? (
              <p className="empty">
                Nenhum profissional cadastrado. <Link href="/agenda/professionals">Cadastrar</Link>
              </p>
            ) : (
              <ul className="plain-list">
                {professionals.map((p) => {
                  const doDia = ativos.filter((a) => a.professionalId === p.id)
                  const minutos = doDia.reduce(
                    (acc, a) => acc + minutesBetween(a.startsAt, a.endsAt),
                    0,
                  )
                  return (
                    <li key={p.id}>
                      <Link
                        href={`/agenda?date=${today}&professional=${p.id}`}
                        className="attn-row"
                      >
                        <span className="avatar sm">{initials(p.name)}</span>
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span className="attn-name">{p.name}</span>
                          <span className="faint">{p.specialty ?? 'Sem especialidade'}</span>
                        </span>
                        <span className="faint tabular" style={{ textAlign: 'right' }}>
                          {doDia.length} {doDia.length === 1 ? 'consulta' : 'consultas'}
                          <br />
                          {minutos > 0
                            ? `${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, '0')}`
                            : '—'}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

        </div>
      </div>
    </div>
  )
}
