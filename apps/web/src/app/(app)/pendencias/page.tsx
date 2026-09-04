import type { ClinicMemberSummary, Page, TaskDetail, TaskEventView, TaskListItem } from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { loadForActiveClinic } from '../../session'
import { PerfMeta } from '../../ui/perf-meta'
import { PendenciasWorkspace } from './workspace'
import { ehVisaoValida, filtroDaVisao, VISAO_PADRAO } from './pendencias-visoes'

export const dynamic = 'force-dynamic'

interface PageProps {
  searchParams: Promise<{ v?: string; id?: string }>
}

/**
 * Fila operacional de Pendencias.
 *
 * Master-detail na query string, como Atendimento: `?v=` escolhe a visao,
 * `?id=` seleciona a pendencia cujo drawer esta aberto. Sem `?id=`, nenhum
 * drawer abre sozinho — ao contrario da fila do Atendimento, aqui NAO ha
 * auto-selecao do primeiro item: uma lista de tarefas se le inteira, uma
 * conversa se abre.
 */
export default async function PendenciasPage({ searchParams }: PageProps) {
  const params = await searchParams
  const visao = ehVisaoValida(params.v) ? params.v : VISAO_PADRAO
  const filtro = filtroDaVisao(visao)

  const query = new URLSearchParams({
    limit: '50',
    status: filtro.status,
    due: filtro.due,
    assignment: filtro.assignment,
  })

  /** Complemento: se falhar, a tela ainda serve com o resto. */
  const opcional = <T,>(p: Promise<T>, vazio: T): Promise<T> =>
    p.catch((error: unknown) => {
      if (!(error instanceof ApiError)) throw error
      return vazio
    })

  /*
   * O historico tem tratamento PROPRIO: os outros `opcional(...)` viram lista
   * vazia em caso de falha porque vazio e um estado legitimo pra eles. Vazio
   * NAO e um estado legitimo pro historico — toda pendencia tem pelo menos o
   * evento `created` —, entao aqui a falha vira uma flag propria em vez de se
   * disfarcar de "sem eventos ainda".
   */
  const buscarEventos = async (
    clinicId: string,
    taskId: string | undefined,
  ): Promise<{ eventos: Page<TaskEventView>; eventosFalhou: boolean }> => {
    if (!taskId) return { eventos: { items: [], nextCursor: null }, eventosFalhou: false }
    try {
      const eventos = await apiFetch<Page<TaskEventView>>(`/api/tasks/${taskId}/events?limit=30`, {
        clinicId,
      })
      return { eventos, eventosFalhou: false }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      return { eventos: { items: [], nextCursor: null }, eventosFalhou: true }
    }
  }

  const { session, data } = await loadForActiveClinic(async (clinicId) => {
    const selecionada = params.id

    const [lista, detalhe, { eventos, eventosFalhou }, equipe] = await Promise.all([
      apiFetch<Page<TaskListItem>>(`/api/tasks?${query.toString()}`, { clinicId }),
      selecionada
        ? opcional(
            apiFetch<TaskDetail>(`/api/tasks/${selecionada}`, { clinicId }),
            null as TaskDetail | null,
          )
        : Promise.resolve(null),
      buscarEventos(clinicId, selecionada),
      opcional(
        apiFetch<ClinicMemberSummary[]>('/api/clinics/members', { clinicId }),
        [] as ClinicMemberSummary[],
      ),
    ])

    return { lista, detalhe, eventos, eventosFalhou, equipe }
  })

  return (
    <div className="content flush">
      <PerfMeta />
      <PendenciasWorkspace
        visao={visao}
        lista={data.lista}
        pendencia={data.detalhe}
        eventos={data.eventos}
        eventosFalhou={data.eventosFalhou}
        equipe={data.equipe}
        timezone={session.activeClinic.clinicTimezone}
      />
    </div>
  )
}
