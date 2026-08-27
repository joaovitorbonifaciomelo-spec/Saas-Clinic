import { z } from 'zod'
import type { ClinicRole } from './roles'

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

/** v0.1 aceita SOMENTE canal manual — nao ha adaptador externo conectado. */
export const createConversationSchema = z.object({
  channel: z.literal('manual'),
  contactPhoneE164: phoneE164Schema.nullable().optional(),
  contactName: z
    .string()
    .trim()
    .max(120)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  patientId: z.uuid().nullable().optional(),
  firstMessage: z
    .object({
      direction: messageDirectionSchema,
      body: bodySchema,
      occurredAt: instantSchema.optional(),
    })
    .optional(),
})

export const addMessageSchema = z.object({
  direction: messageDirectionSchema,
  body: bodySchema,
  occurredAt: instantSchema.optional(),
})

/**
 * Toda mutacao de CONTROLE carrega a versao que a tela viu.
 *
 * Nao existe variante sem versao: uma operacao de controle sem versao e uma
 * corrida esperando para acontecer, e deixar o campo opcional garantiria que
 * alguem esqueceria de mandar.
 */
const versioned = z.object({ version: z.number().int().positive() })

export const assignConversationSchema = versioned
export const releaseConversationSchema = versioned
export const transferConversationSchema = versioned.extend({ toUserId: z.uuid() })
export const changeConversationStatusSchema = versioned.extend({
  status: conversationStatusSchema,
})
export const linkPatientSchema = versioned.extend({ patientId: z.uuid() })
export const unlinkPatientSchema = versioned

export type CreateConversationInput = z.infer<typeof createConversationSchema>
export type AddMessageInput = z.infer<typeof addMessageSchema>
export type TransferConversationInput = z.infer<typeof transferConversationSchema>
export type ChangeConversationStatusInput = z.infer<typeof changeConversationStatusSchema>
export type LinkPatientInput = z.infer<typeof linkPatientSchema>

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
  > {
  /** Vem de join, nunca de coluna desnormalizada: nome muda. */
  assignedToName: string | null
  patientName: string | null
  /** Resolvido no servidor — trazer a ultima mensagem inteira seria N+1. */
  lastMessagePreview: string | null
  needsReply: boolean
}

export interface Message {
  id: string
  clinicId: string
  conversationId: string
  direction: MessageDirection
  body: string
  occurredAt: string
  authorUserId: string | null
  authorNameSnapshot: string | null
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
export interface ConversationVersionConflict {
  error: typeof CONVERSATION_VERSION_CONFLICT
  current: ConversationListItem
}
