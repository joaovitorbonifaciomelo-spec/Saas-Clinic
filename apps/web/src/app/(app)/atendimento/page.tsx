import {
  type ClinicMemberSummary,
  type ConversationDetail,
  type ConversationEventView,
  type ConversationListItem,
  type Message,
  type Page,
} from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { loadForActiveClinic } from '../../session'
import { PerfMeta } from '../../ui/perf-meta'
import { AtendimentoWorkspace } from './workspace'
import { filtroDaVisao, VISOES, type VisaoFila } from './visoes'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ c?: string; v?: string; q?: string }>
}


/**
 * Caixa operacional do Atendimento.
 *
 * Master-detail na query string, como Pacientes: `?c=<id>` seleciona a conversa,
 * `?v=` a visao, `?q=` a busca. Trocar de conversa e navegacao client-side que
 * mantem o shell e a fila montados, e a URL continua compartilhavel.
 *
 * A thread e o contexto do paciente sao buscados em PARALELO com a fila quando
 * ja ha conversa na URL — nenhum deles depende da lista para existir.
 */
export default async function AtendimentoPage({ searchParams }: PageProps) {
  const params = await searchParams
  const visao: VisaoFila = params.v && params.v in VISOES ? (params.v as VisaoFila) : 'todas'
  const filtro = filtroDaVisao(visao)

  const query = new URLSearchParams({ limit: '25' })
  if (filtro.status) query.set('status', filtro.status)
  if (filtro.assignment) query.set('assignment', filtro.assignment)
  if (params.q) query.set('q', params.q)

  /** Complemento: se falhar, a tela ainda serve com o resto. */
  const opcional = <T,>(p: Promise<T>, vazio: T): Promise<T> =>
    p.catch((error: unknown) => {
      if (!(error instanceof ApiError)) throw error
      return vazio
    })

  const { session, data } = await loadForActiveClinic(async (clinicId) => {
    const selecionada = params.c

    const [fila, detalhe, mensagens, eventos, equipe] = await Promise.all([
      apiFetch<Page<ConversationListItem>>(`/api/conversations?${query.toString()}`, { clinicId }),
      selecionada
        ? opcional(
            apiFetch<ConversationDetail>(`/api/conversations/${selecionada}`, { clinicId }),
            null as ConversationDetail | null,
          )
        : Promise.resolve(null),
      selecionada
        ? opcional(
            apiFetch<Page<Message>>(`/api/conversations/${selecionada}/messages?limit=100`, {
              clinicId,
            }),
            { items: [], nextCursor: null } as Page<Message>,
          )
        : Promise.resolve({ items: [], nextCursor: null } as Page<Message>),
      selecionada
        ? opcional(
            apiFetch<Page<ConversationEventView>>(
              `/api/conversations/${selecionada}/events?limit=100`,
              { clinicId },
            ),
            { items: [], nextCursor: null } as Page<ConversationEventView>,
          )
        : Promise.resolve({ items: [], nextCursor: null } as Page<ConversationEventView>),
      opcional(
        apiFetch<ClinicMemberSummary[]>('/api/clinics/members', { clinicId }),
        [] as ClinicMemberSummary[],
      ),
    ])

    return { fila, detalhe, mensagens, eventos, equipe }
  })

  /*
   * Sem `?c=` na URL, abre a primeira da fila — painel vazio nao ajuda ninguem.
   * O detalhe dela vem numa segunda ida, e so neste caso: quando a URL ja traz
   * a conversa, tudo veio em paralelo acima.
   */
  const primeira = data.fila.items[0]
  let detalhe = data.detalhe
  let mensagens = data.mensagens
  let eventos = data.eventos

  if (!detalhe && primeira) {
    const clinicId = session.activeClinic.clinicId
    const [d, m, e] = await Promise.all([
      opcional(
        apiFetch<ConversationDetail>(`/api/conversations/${primeira.id}`, { clinicId }),
        null as ConversationDetail | null,
      ),
      opcional(
        apiFetch<Page<Message>>(`/api/conversations/${primeira.id}/messages?limit=100`, {
          clinicId,
        }),
        { items: [], nextCursor: null } as Page<Message>,
      ),
      opcional(
        apiFetch<Page<ConversationEventView>>(
          `/api/conversations/${primeira.id}/events?limit=100`,
          { clinicId },
        ),
        { items: [], nextCursor: null } as Page<ConversationEventView>,
      ),
    ])
    detalhe = d
    mensagens = m
    eventos = e
  }

  return (
    <div className="content flush">
      <PerfMeta />
      <AtendimentoWorkspace
        visao={visao}
        busca={params.q ?? ''}
        fila={data.fila}
        conversa={detalhe}
        conversaNaUrl={params.c !== undefined}
        mensagens={mensagens}
        eventos={eventos}
        equipe={data.equipe}
        timezone={session.activeClinic.clinicTimezone}
      />
    </div>
  )
}
