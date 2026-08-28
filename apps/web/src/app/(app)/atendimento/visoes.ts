/**
 * Visoes da fila.
 *
 * Todas DERIVADAS de `status` + responsavel — nenhuma e um estado novo no
 * banco. "Novas" e literalmente `open + sem responsavel`; se virasse coluna,
 * divergiria do estado real na primeira vez que alguem assumisse uma conversa
 * por outro caminho.
 *
 * Vive em modulo proprio (e nao no arquivo da pagina) para que os componentes
 * de cliente importem o mapa sem tocar no modulo de servidor.
 */
export const VISOES = {
  todas: {},
  novas: { status: 'open', assignment: 'unassigned' },
  minhas: { assignment: 'mine' },
  sem_responsavel: { assignment: 'unassigned' },
  aguardando: { status: 'waiting_patient' },
  encerradas: { status: 'resolved' },
} as const satisfies Record<string, { status?: string; assignment?: string }>

export type VisaoFila = keyof typeof VISOES

export const VISOES_UI: { chave: VisaoFila; rotulo: string }[] = [
  { chave: 'todas', rotulo: 'Todas' },
  { chave: 'novas', rotulo: 'Novas' },
  { chave: 'minhas', rotulo: 'Minhas' },
  { chave: 'sem_responsavel', rotulo: 'Sem responsável' },
  { chave: 'aguardando', rotulo: 'Aguardando paciente' },
  { chave: 'encerradas', rotulo: 'Encerradas' },
]

export function filtroDaVisao(visao: VisaoFila): { status?: string; assignment?: string } {
  return VISOES[visao]
}

/** Copy de apresentacao. Os valores do dominio nao mudam. */
export const STATUS_UI: Record<string, string> = {
  open: 'Em atendimento',
  waiting_patient: 'Aguardando paciente',
  resolved: 'Encerrado',
}

export const PAPEL_UI: Record<string, string> = {
  admin: 'Administrador',
  attendant: 'Recepção',
  professional: 'Profissional',
}
