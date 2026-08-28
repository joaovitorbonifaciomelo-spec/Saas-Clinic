import { z } from 'zod'
import type { ClinicRole } from './roles'
import type { AppointmentStatus } from './appointment'

/* =============================================================================
   Canal e provedor
   -----------------------------------------------------------------------------
   Sao coisas diferentes, e a distincao governa a identidade da thread:

     channel  = a natureza do canal          -> ENTRA na identidade
     provider = a infraestrutura que entrega -> NAO entra quando ha telefone

   Trocar Evolution por Meta Cloud nao pode criar uma thread nova para cada
   paciente. Por isso `channel` e enum de dominio e `provider` e texto livre
   validado aqui: acrescentar um adaptador nao deve exigir migration.
   ========================================================================== */

export const CONVERSATION_CHANNELS = ['manual', 'whatsapp'] as const
export const conversationChannelSchema = z.enum(CONVERSATION_CHANNELS)
export type ConversationChannel = z.infer<typeof conversationChannelSchema>

export const CONVERSATION_CHANNEL_LABELS: Record<ConversationChannel, string> = {
  manual: 'Registro manual',
  whatsapp: 'WhatsApp',
}

/** Adaptadores conhecidos. A lista vive aqui, junto do codigo, e nao no banco. */
export const CONVERSATION_PROVIDERS = ['meta_cloud', 'evolution'] as const
export type ConversationProvider = (typeof CONVERSATION_PROVIDERS)[number]

export const PROVIDER_MIN = 2
export const PROVIDER_MAX = 40

/**
 * Canal manual nao tem infraestrutura de entrega; canal externo obrigatoriamente
 * tem. Espelha o `conversations_channel_provider_check` do banco.
 */
export function isValidChannelProviderPair(
  channel: ConversationChannel,
  provider: string | null | undefined,
): boolean {
  const limpo = provider?.trim() ?? null
  if (channel === 'manual') return limpo === null || limpo === ''
  return limpo !== null && limpo.length >= PROVIDER_MIN && limpo.length <= PROVIDER_MAX
}

/* =============================================================================
   Telefone em E.164
   -----------------------------------------------------------------------------
   ATENCAO: este NAO e o mesmo formato de `patient.phone`, que guarda so digitos
   nacionais. Aqui a identidade da thread e internacional e precisa do prefixo do
   pais, senao dois numeros de paises diferentes colidiriam.

   A normalizacao acontece na BORDA (adaptador de entrada ou formulario). O
   schema abaixo valida o resultado; ele nao adivinha o pais de um numero solto.
   ========================================================================== */

export const E164_RE = /^\+[1-9][0-9]{7,14}$/

export const phoneE164Schema = z
  .string()
  .trim()
  .regex(E164_RE, 'Telefone deve estar em E.164 (ex.: +5511987654321).')

/**
 * Converte um telefone brasileiro digitado com mascara para E.164.
 *
 * Devolve `null` quando nao da para ter certeza — e nao chutar aqui e o ponto:
 * um numero mal convertido vira a identidade errada de uma thread, e duas
 * pessoas passam a compartilhar a mesma conversa.
 */
export function toE164BR(input: string): string | null {
  const bruto = input.trim()
  const digitos = bruto.replace(/\D/g, '')

  const nacional = (n: string): string | null =>
    n.length === 10 || n.length === 11 ? `+55${n}` : null

  /*
   * Se ja veio com "+", o numero DECLAROU o pais dele. So convertemos quando
   * esse pais e o Brasil.
   *
   * Sem esta guarda, "+1 415 555 0100" perde o "+", vira 11 digitos, cai na
   * regra de celular brasileiro e sai como "+5514155550100" — um numero
   * americano silenciosamente transformado em brasileiro. Como o telefone e a
   * identidade da thread, isso colocaria duas pessoas diferentes na mesma
   * conversa. Foi um teste que pegou; o comentario existe para nao voltar.
   */
  if (bruto.startsWith('+')) {
    if (!digitos.startsWith('55')) return null
    return nacional(digitos.slice(2))
  }

  if (digitos.length === 10 || digitos.length === 11) return `+55${digitos}`
  if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) {
    return nacional(digitos.slice(2))
  }
  return null
}

/* =============================================================================
   Status
   ========================================================================== */

export const CONVERSATION_STATUSES = ['open', 'waiting_patient', 'resolved'] as const
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES)
export type ConversationStatus = z.infer<typeof conversationStatusSchema>

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  open: 'Em aberto',
  waiting_patient: 'Aguardando paciente',
  resolved: 'Resolvida',
}

/**
 * Transicoes permitidas.
 *
 * NENHUM estado e terminal — diferenca deliberada em relacao a
 * APPOINTMENT_STATUS_TRANSITIONS, onde tres estados tem array vazio. Um
 * agendamento realizado nao volta atras; uma conversa sempre pode receber outra
 * mensagem, e travar `resolved` perderia mensagem.
 *
 * `resolved -> waiting_patient` fica de fora de proposito: reabrir devolve a
 * fila da clinica, e so de la a conversa volta a esperar o paciente. Um passo,
 * nao dois.
 *
 * Espelhado no trigger `enforce_conversation_status_transition` do banco. Se um
 * dos dois mudar, o outro muda junto.
 */
export const CONVERSATION_STATUS_TRANSITIONS: Record<
  ConversationStatus,
  readonly ConversationStatus[]
> = {
  open: ['waiting_patient', 'resolved'],
  waiting_patient: ['open', 'resolved'],
  resolved: ['open'],
}

export function canTransitionConversation(
  from: ConversationStatus,
  to: ConversationStatus,
): boolean {
  return CONVERSATION_STATUS_TRANSITIONS[from].includes(to)
}

/* =============================================================================
   Mensagens
   ========================================================================== */

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const
export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS)
export type MessageDirection = z.infer<typeof messageDirectionSchema>

export const MESSAGE_DIRECTION_LABELS: Record<MessageDirection, string> = {
  inbound: 'Recebida',
  outbound: 'Enviada',
}

export const MESSAGE_DELIVERY_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'failed',
] as const
export const messageDeliveryStatusSchema = z.enum(MESSAGE_DELIVERY_STATUSES)
export type MessageDeliveryStatus = z.infer<typeof messageDeliveryStatusSchema>

export const MESSAGE_BODY_MIN = 1
export const MESSAGE_BODY_MAX = 4096

/* =============================================================================
   Eventos
   ========================================================================== */

export const CONVERSATION_EVENT_TYPES = [
  'conversation_created',
  'assigned',
  'transferred',
  'released',
  'patient_linked',
  'patient_unlinked',
  'status_changed',
  'appointment_created',
] as const
export const conversationEventTypeSchema = z.enum(CONVERSATION_EVENT_TYPES)
export type ConversationEventType = z.infer<typeof conversationEventTypeSchema>

/**
 * Um tipo por OPERACAO que a pessoa executa, nao por valor resultante.
 *
 * Nao existem `resolved` nem `reopened`: sao a mesma operacao — transicao de
 * status pelo mesmo endpoint — e `status_changed` com {from,to} representa
 * integralmente. Ja `assigned`, `transferred` e `released` sao tres operacoes
 * diferentes, com tres endpoints e tres frases diferentes na tela.
 */
export const CONVERSATION_EVENT_LABELS: Record<ConversationEventType, string> = {
  conversation_created: 'Conversa criada',
  assigned: 'Atendimento assumido',
  transferred: 'Atendimento transferido',
  released: 'Devolvida à fila',
  patient_linked: 'Paciente vinculado',
  patient_unlinked: 'Vínculo de paciente removido',
  status_changed: 'Situação alterada',
  appointment_created: 'Agendamento criado a partir da conversa',
}

/* =============================================================================
   Entradas da API

   `clinicId` NAO aparece em nenhum payload, por construcao: o tenant vem do
   header validado pelo guard. Autoria idem — vem do JWT e e carimbada por
   trigger. Se estivessem aqui, o cliente escolheria de quem e a conversa.
   ========================================================================== */

const bodySchema = z.string().trim().min(MESSAGE_BODY_MIN).max(MESSAGE_BODY_MAX)

const instantSchema = z
  .string()
  .datetime({ offset: true, message: 'Informe um instante ISO-8601 com fuso.' })

/**
 * Tolerancia de relogio para `occurredAt`.
 *
 * O passado e legitimo: o modo manual existe para registrar o que aconteceu
 * fora do sistema, e isso e sempre depois do fato. O futuro nao e — a fila
 * ordena por `last_message_at`, e o banco o atualiza com `greatest()`, entao
 * um instante a frente prende a conversa no topo e NENHUMA mensagem real
 * posterior desfaz. Os cinco minutos existem so para o relogio do cliente
 * estar adiantado, nao para conceder margem.
 */
export const OCCURRED_AT_FUTURE_TOLERANCE_MS = 5 * 60_000

const occurredAtSchema = instantSchema.refine(
  (valor) => Date.parse(valor) <= Date.now() + OCCURRED_AT_FUTURE_TOLERANCE_MS,
  { message: 'occurredAt nao pode estar no futuro.' },
)

/**
 * Entrada de criacao de conversa MANUAL.
 *
 * O que NAO esta aqui e a parte importante: `channel`, `provider`, `status`,
 * `assignedTo`, `version` e timestamps nao sao aceitos do cliente. Quem os
 * define e o banco, dentro de `conversation_create_manual`. Um campo a mais
 * neste schema seria um campo a mais que alguem pode forjar.
 *
 * `contactPhone` entra CRU: quem digita usa `(11) 98765-4321`. A normalizacao
 * para E.164 acontece uma unica vez, em `toE164BR`, e nao aqui.
 */
export const registerConversationSchema = z
  .object({
    contactPhone: z.string().trim().max(40).nullish(),
    contactName: z
      .string()
      .trim()
      .max(120)
      .transform((valor) => (valor === '' ? null : valor))
      .nullish(),
    patientId: z.uuid().nullish(),
  })
  /*
   * ESTRITO: campo desconhecido e 400, nao descarte silencioso.
   *
   * Quem manda `channel: 'whatsapp'` acredita ter criado uma conversa de
   * WhatsApp. Ignorar em silencio devolveria 201 e uma conversa manual, e a
   * pessoa so descobriria a divergencia muito depois — talvez ao perceber que
   * o paciente nunca recebeu nada. Recusar transforma um mal-entendido
   * silencioso em erro imediato.
   */
  .strict()

/**
 * Entrada de REGISTRO de mensagem manual.
 *
 * "Registro", nao "envio": este caminho nao manda nada para lugar nenhum. Ele
 * anota no sistema uma conversa que aconteceu por fora — telefone, balcao,
 * WhatsApp pessoal. O nome do tipo carrega isso de proposito, para que ninguem
 * leia a chamada e presuma entrega.
 *
 * Ausentes por construcao: `clinicId` (vem da conversa), `channel` e
 * `provider` (carimbados por trigger), `deliveryStatus` (manual nunca finge
 * entrega), `author*` e `recordedBy*` (carimbados a partir de auth.uid()).
 */
export const registerManualMessageSchema = z
  .object({
    direction: messageDirectionSchema,
    body: bodySchema,
    occurredAt: occurredAtSchema.nullish(),
  })
  /*
   * ESTRITO pelo mesmo motivo, e aqui o risco e maior: um cliente que envia
   * `deliveryStatus: 'delivered'` ou `authorUserId` esta tentando afirmar algo
   * que nao lhe cabe. Descartar em silencio devolveria 201 e deixaria quem
   * escreveu o cliente achando que a afirmacao valeu.
   */
  .strict()

/** @deprecated Mantido enquanto o Bloco 3 nao reescreve o caminho de escrita. */
export const createConversationSchema = registerConversationSchema
export const addMessageSchema = registerManualMessageSchema

/**
 * Toda mutacao de CONTROLE carrega a versao que a tela viu.
 *
 * Nao existe variante sem versao: uma operacao de controle sem versao e uma
 * corrida esperando para acontecer, e deixar o campo opcional garantiria que
 * alguem esqueceria de mandar.
 */
const versioned = z.object({
  /*
   * A VERSAO QUE A TELA VIU.
   *
   * Obrigatoria e sem default. Um default silencioso (ou o campo opcional)
   * transformaria toda operacao de controle numa corrida: quem esqueceu de
   * mandar sobrescreveria a decisao de quem chegou antes, e ninguem saberia.
   */
  expectedVersion: z.number().int().positive(),
})

/** Assumir = atribuir a SI MESMO. Nao ha campo de usuario, de proposito. */
export const assignConversationSchema = versioned.strict()

export const releaseConversationSchema = versioned.strict()

export const transferConversationSchema = versioned
  .extend({ assigneeUserId: z.uuid() })
  .strict()

export const setConversationStatusSchema = versioned
  .extend({ status: conversationStatusSchema })
  .strict()

export const linkConversationPatientSchema = versioned
  .extend({ patientId: z.uuid() })
  .strict()

/*
 * Desvincular chega por DELETE, que nao carrega corpo de forma confiavel
 * atraves de proxies. A versao vem na query string — continua obrigatoria, so
 * muda o transporte. `coerce` porque query string e sempre texto.
 */
export const unlinkConversationPatientSchema = z
  .object({ expectedVersion: z.coerce.number().int().positive() })
  .strict()

/** @deprecated nomes antigos, mantidos enquanto nada mais os referencia. */
export const changeConversationStatusSchema = setConversationStatusSchema
export const linkPatientSchema = linkConversationPatientSchema
export const unlinkPatientSchema = unlinkConversationPatientSchema

export type RegisterConversationInput = z.infer<typeof registerConversationSchema>
export type RegisterManualMessageInput = z.infer<typeof registerManualMessageSchema>
export type CreateConversationInput = RegisterConversationInput
export type AddMessageInput = RegisterManualMessageInput

/**
 * Resposta da criacao manual.
 *
 * `created` distingue os dois caminhos SEM usar erro para isso: um telefone que
 * ja tem thread nao e falha, e sim a resposta certa — a atendente quer abrir
 * aquela conversa, nao ver um 409. O HTTP acompanha (201 x 200), mas quem
 * programa a tela le este campo, nao o status.
 */
export interface RegisterConversationResult {
  created: boolean
  conversation: Conversation
}

/**
 * Resposta do registro de mensagem.
 *
 * `conversation` vem junto porque uma mensagem inbound pode REABRIR a conversa:
 * sem devolver o estado, a tela mostraria "resolvida" logo apos algo que a
 * reabriu, e so descobriria no proximo refresh.
 */
export interface RegisterManualMessageResult {
  message: Message
  conversation: Conversation
}
export type ConversationControlInput = z.infer<typeof versioned>
export type AssignConversationInput = z.infer<typeof assignConversationSchema>
export type ReleaseConversationInput = z.infer<typeof releaseConversationSchema>
export type TransferConversationInput = z.infer<typeof transferConversationSchema>
export type SetConversationStatusInput = z.infer<typeof setConversationStatusSchema>
export type LinkConversationPatientInput = z.infer<typeof linkConversationPatientSchema>
export type UnlinkConversationPatientInput = z.infer<typeof unlinkConversationPatientSchema>
export type ChangeConversationStatusInput = SetConversationStatusInput
export type LinkPatientInput = LinkConversationPatientInput

/* =============================================================================
   Formas de leitura
   ========================================================================== */

export interface Conversation {
  id: string
  clinicId: string
  channel: ConversationChannel
  provider: string | null
  providerContactId: string | null
  contactPhoneE164: string | null
  contactNameSnapshot: string | null
  patientId: string | null
  status: ConversationStatus
  assignedTo: string | null
  lastMessageAt: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

/**
 * Uma linha da fila. So o que a lista desenha — a thread inteira nunca vem aqui.
 */
export interface ConversationListItem
  extends Pick<
    Conversation,
    | 'id'
    | 'channel'
    | 'status'
    | 'assignedTo'
    | 'patientId'
    | 'contactPhoneE164'
    | 'contactNameSnapshot'
    | 'lastMessageAt'
    | 'version'
    | 'updatedAt'
  > {
  /**
   * Nome de quem esta atendendo, quando foi possivel resolver.
   *
   * NULO NAO SIGNIFICA "sem responsavel" — para isso existe `assignedTo`.
   * Significa que o nome nao foi resolvivel: a policy de `profiles` e
   * `id = auth.uid()`, entao ninguem le o nome de um colega. O servidor
   * recupera o que consegue dos snapshots de auditoria; quem nunca agiu na
   * clinica ainda nao tem nome conhecido. Ver `assignedToIsMe`.
   */
  assignedToName: string | null
  /** Sempre confiavel, mesmo quando o nome nao resolve. A UI diz "Voce". */
  assignedToIsMe: boolean
  /** Vem de join, nunca de coluna desnormalizada: nome de paciente muda. */
  patientName: string | null
  /** Resolvido no servidor com um unico join — trazer a thread seria N+1. */
  lastMessagePreview: string | null
  lastMessageDirection: MessageDirection | null
  /** Derivado de lastInboundAt > lastOutboundAt; ver needsReply(). */
  needsReply: boolean
}

/**
 * Um paciente visto de dentro do Atendimento.
 *
 * Deliberadamente menor que `Patient`: a tela de conversa precisa identificar
 * e ligar para a pessoa, nao editar o cadastro dela.
 */
export interface ConversationPatientSummary {
  id: string
  name: string
  phone: string
}

/** Proxima consulta futura do paciente vinculado, quando existir. */
export interface ConversationNextAppointment {
  id: string
  startsAt: string
  endsAt: string
  status: AppointmentStatus
  professionalName: string | null
  serviceName: string | null
}

/**
 * A conversa aberta na tela. Ainda NAO traz mensagens: elas tem endpoint e
 * paginacao proprios, porque uma thread longa nao cabe numa resposta so.
 */
export interface ConversationDetail extends Conversation {
  assignedToName: string | null
  assignedToIsMe: boolean
  patient: ConversationPatientSummary | null
  nextAppointment: ConversationNextAppointment | null
  needsReply: boolean
}

/**
 * Evento como a UI o le. `metadata` NAO e repassado cru: o banco aceita chaves
 * que so fazem sentido para o servidor, e o que sai daqui e uma lista fechada.
 */
export interface ConversationEventView {
  id: string
  eventType: ConversationEventType
  actorNameSnapshot: string | null
  actorRoleSnapshot: ClinicRole | null
  createdAt: string
  /** Somente as chaves da lista branca; ver CONVERSATION_EVENT_METADATA_KEYS. */
  metadata: ConversationEventMetadata
}

/**
 * Chaves de metadata que podem sair para o cliente, por tipo de evento.
 *
 * Lista fechada de proposito. `metadata` e jsonb: hoje guarda o que as funcoes
 * de controle escrevem, mas um adaptador futuro pode gravar ali payload de
 * provedor. Repassar o objeto inteiro faria esse dia virar um vazamento
 * silencioso, sem nenhuma linha de codigo mudando.
 */
export const CONVERSATION_EVENT_METADATA_KEYS = [
  'from',
  'to',
  'reason',
  'from_user_id',
  'to_user_id',
  'patient_id',
  'appointment_id',
] as const

export type ConversationEventMetadataKey = (typeof CONVERSATION_EVENT_METADATA_KEYS)[number]
export type ConversationEventMetadata = Partial<Record<ConversationEventMetadataKey, unknown>>

/* =============================================================================
   Paginacao
   ========================================================================== */

/**
 * Pagina generica com cursor.
 *
 * Cursor e nao offset: a fila muda embaixo do leitor a cada mensagem que chega.
 * Com offset, uma conversa que sobe para o topo entre duas paginas faz outra
 * descer uma posicao e sumir — a pessoa nunca a ve, e nada indica que faltou.
 * O cursor ancora numa linha concreta, entao o pior caso e repetir, nao perder.
 *
 * `nextCursor` nulo significa fim. NAO significa "tente de novo depois".
 */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export const PAGE_LIMIT_DEFAULT = 30
export const PAGE_LIMIT_MAX = 100

/** Filtro por quem atende. `mine` depende do auth.uid() da requisicao. */
export const CONVERSATION_ASSIGNMENT_FILTERS = ['mine', 'unassigned', 'all'] as const
export const conversationAssignmentFilterSchema = z.enum(CONVERSATION_ASSIGNMENT_FILTERS)
export type ConversationAssignmentFilter = z.infer<typeof conversationAssignmentFilterSchema>

/** Tamanho maximo da busca livre. Acima disso nao e busca, e payload. */
export const CONVERSATION_SEARCH_MAX = 80

export const listConversationsQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  assignment: conversationAssignmentFilterSchema.default('all'),
  patientId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(CONVERSATION_SEARCH_MAX).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().optional(),
})

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).default(PAGE_LIMIT_DEFAULT),
  cursor: z.string().optional(),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export interface Message {
  id: string
  clinicId: string
  conversationId: string
  /**
   * Carimbado pelo banco a partir da conversa, nunca informado pelo cliente.
   * A UI depende disso para nao exibir estado de entrega em mensagem manual.
   */
  channel: ConversationChannel
  direction: MessageDirection
  body: string
  occurredAt: string
  /** Quem DISSE. Nulo em inbound: quem disse foi o paciente. */
  authorUserId: string | null
  authorNameSnapshot: string | null
  /** Quem da equipe REGISTROU o fato. Nulo quando nao ha pessoa (webhook). */
  recordedByUserId: string | null
  recordedByNameSnapshot: string | null
  provider: string | null
  providerMessageId: string | null
  deliveryStatus: MessageDeliveryStatus | null
  createdAt: string
}

export interface ConversationEvent {
  id: string
  clinicId: string
  conversationId: string
  eventType: ConversationEventType
  actorUserId: string | null
  actorNameSnapshot: string | null
  actorRoleSnapshot: ClinicRole | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface ConversationCounts {
  novas: number
  minhas: number
  emAtendimento: number
  aguardandoPaciente: number
  precisamResposta: number
  resolvidas: number
}

/* =============================================================================
   Sinais derivados

   Decisao 4: nenhuma coluna acumuladora. Contador que sobe e desce em dois
   caminhos diferentes sempre diverge; timestamps sao fatos.
   ========================================================================== */

/**
 * O paciente falou depois da ultima vez que a clinica respondeu.
 *
 * Mede TRABALHO PENDENTE, nao se alguem passou o olho — e por isso substitui
 * "nao lida" numa caixa compartilhada, onde ler nao e o mesmo que resolver.
 */
export function needsReply(c: {
  lastInboundAt: string | null
  lastOutboundAt: string | null
}): boolean {
  if (c.lastInboundAt === null) return false
  if (c.lastOutboundAt === null) return true
  return c.lastInboundAt > c.lastOutboundAt
}

/** "Nova" e visao derivada, nunca estado guardado. */
export function isUnclaimed(c: { status: ConversationStatus; assignedTo: string | null }): boolean {
  return c.status === 'open' && c.assignedTo === null
}

/* =============================================================================
   Conflito de versao
   ========================================================================== */

/**
 * Resultado das funcoes de controle do banco.
 *
 * As RPCs devolvem "outcome" em vez de lancar excecao para o caso esperado: um
 * conflito de versao e fluxo normal de caixa compartilhada, nao erro. A API
 * mapeia "conflict" para 409 e "not_found" para 404.
 *
 * "not_found" cobre inexistente E outro tenant com a MESMA forma, de proposito.
 */
export const CONVERSATION_OUTCOMES = [
  'ok',
  'conflict',
  'not_found',
  'exists',
  'not_manual',
  'invalid_body',
] as const
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number]

export const CONVERSATION_VERSION_CONFLICT = 'CONVERSATION_VERSION_CONFLICT' as const

/**
 * Corpo do 409.
 *
 * Devolve o ESTADO ATUAL para a tela poder dizer "Ana assumiu esta conversa"
 * em vez de "erro ao salvar". Um 409 sem estado obriga a pessoa a recarregar
 * para descobrir o que aconteceu.
 *
 * Conversa inexistente ou de outro tenant NAO chega aqui: responde 404, com o
 * mesmo corpo dos dois casos, para nao revelar existencia.
 */
/**
 * Um membro da equipe, como a tela precisa dele.
 *
 * Tres campos porque a operacao precisa de tres: identificar (`userId`), exibir
 * (`displayName`) e diferenciar papeis na UI (`role`). Sem e-mail e sem
 * metadados de auth — o read model do banco ja nao os devolve.
 *
 * `displayName` nulo significa "nome indisponivel", NUNCA "sem responsavel".
 */
export interface ClinicMemberSummary {
  userId: string
  displayName: string | null
  role: ClinicRole
}

export const CONVERSATION_CONFLICT_ERROR = 'conversation_conflict' as const

export const CONVERSATION_PATIENT_ALREADY_LINKED = 'conversation_patient_already_linked' as const

/**
 * 409 de "ja existe outro paciente vinculado".
 *
 * E um 409 DIFERENTE do conflito de versao, e a distincao importa para a tela:
 * conflito de versao pede "recarregue e tente de novo"; este pede uma acao do
 * usuario — desvincular antes. Se os dois compartilhassem o mesmo `error`, a UI
 * so poderia oferecer a saida errada para um dos casos.
 *
 * `conversation` e o estado ATUAL, que quem chamou ja podia ler. NAO ha nada
 * aqui sobre o paciente SOLICITADO: dizer se ele existe, se e de outra clinica
 * ou se o id esta errado seria informacao sobre um cadastro que o chamador pode
 * nao poder enxergar.
 */
export interface ConversationPatientAlreadyLinkedResponse {
  statusCode: 409
  error: typeof CONVERSATION_PATIENT_ALREADY_LINKED
  message: string
  conversation: Conversation
}

/** Texto de UX, fixado aqui para a API e o frontend nao divergirem. */
export const CONVERSATION_PATIENT_ALREADY_LINKED_MESSAGE =
  'Este atendimento já está vinculado a outro paciente. ' +
  'Desvincule o paciente atual antes de vincular outro.'

/**
 * Corpo do 409 das operacoes de controle.
 *
 * `conversation` e o estado ATUAL, no mesmo formato que os demais endpoints
 * devolvem — a tela re-renderiza com ele e ja mostra quem assumiu, sem
 * recarregar e sem uma segunda requisicao.
 *
 * O QUE NAO ESTA AQUI: mensagem do Postgres, nome de constraint, versao de
 * outras entidades, qualquer dado de outro tenant. E `conversation` so aparece
 * porque quem recebeu 409 JA podia ler essa conversa — se o vinculo tiver sido
 * removido durante a corrida, a resposta e 404 e nao passa por aqui.
 */
export interface ConversationConflictResponse {
  statusCode: 409
  error: typeof CONVERSATION_CONFLICT_ERROR
  message: string
  conversation: Conversation
}

/** @deprecated forma anterior, antes do contrato uniforme do Bloco 3. */
export interface ConversationVersionConflict {
  error: typeof CONVERSATION_VERSION_CONFLICT
  current: ConversationListItem
}
