import { TASK_VIEW_LABELS, type TaskAssignmentFilter, type TaskDueFilter, type TaskStatus, type TaskView } from '@clinicas/shared'

/**
 * Mapa visao -> filtro, no MESMO espirito de `atendimento/visoes.ts`: nenhuma
 * visao e um estado novo, todas sao combinacoes de `status`+`due`+`assignment`
 * que a API ja aceita. A ordem aqui e a ordem de EXIBICAO das abas — o pedido
 * do produto (Hoje, Atrasadas, Próximas...) difere da ordem de `TASK_VIEWS` no
 * pacote compartilhado, que segue a logica do dominio (overdue primeiro).
 */
export const PENDENCIAS_VISOES_UI: { chave: TaskView; rotulo: string }[] = [
  { chave: 'today', rotulo: TASK_VIEW_LABELS.today },
  { chave: 'overdue', rotulo: TASK_VIEW_LABELS.overdue },
  { chave: 'upcoming', rotulo: TASK_VIEW_LABELS.upcoming },
  { chave: 'mine', rotulo: TASK_VIEW_LABELS.mine },
  { chave: 'unassigned', rotulo: TASK_VIEW_LABELS.unassigned },
  { chave: 'undated', rotulo: TASK_VIEW_LABELS.undated },
  { chave: 'completed', rotulo: TASK_VIEW_LABELS.completed },
]

export const VISAO_PADRAO: TaskView = 'today'

interface FiltroLista {
  status: TaskStatus
  due: TaskDueFilter
  assignment: TaskAssignmentFilter
}

/**
 * Traduz a visao para os tres parametros de `GET /api/tasks`.
 *
 * Espelha, campo a campo, o mapeamento que a propria API documenta no
 * controller (`tasks.controller.ts`) — nao e uma escolha nova, e a mesma
 * particao ja aprovada no backend.
 */
export function filtroDaVisao(visao: TaskView): FiltroLista {
  switch (visao) {
    case 'overdue':
      return { status: 'open', due: 'overdue', assignment: 'any' }
    case 'today':
      return { status: 'open', due: 'today', assignment: 'any' }
    case 'upcoming':
      return { status: 'open', due: 'upcoming', assignment: 'any' }
    case 'undated':
      return { status: 'open', due: 'none', assignment: 'any' }
    case 'mine':
      return { status: 'open', due: 'any', assignment: 'mine' }
    case 'unassigned':
      return { status: 'open', due: 'any', assignment: 'unassigned' }
    case 'completed':
      return { status: 'completed', due: 'any', assignment: 'any' }
  }
}

export function ehVisaoValida(v: string | undefined): v is TaskView {
  return v !== undefined && PENDENCIAS_VISOES_UI.some((x) => x.chave === v)
}
