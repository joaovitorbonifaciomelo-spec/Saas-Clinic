import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
import {
  CONVERSATION_EVENT_METADATA_KEYS,
  needsReply,
  toE164BR,
  type Conversation,
  type RegisterConversationInput,
  type RegisterConversationResult,
  type RegisterManualMessageInput,
  type RegisterManualMessageResult,
  type ConversationDetail,
  type ConversationEventMetadata,
  type ConversationEventType,
  type ConversationEventView,
  type ConversationListItem,
  type ConversationNextAppointment,
  type ConversationStatus,
  type ListConversationsQuery,
  type Message,
  type Page,
  type PaginationQuery,
} from '@clinicas/shared'
import type { ClinicRole } from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'
import {
  decodeQueueCursor,
  decodeTimeCursor,
  encodeQueueCursor,
  encodeTimeCursor,
  queueCursorFilter,
  timeCursorFilter,
} from './conversation-cursor'

/* =============================================================================
   Linhas do banco
   ========================================================================== */

interface ConversationRow {
  id: string
  clinic_id: string
  channel: 'manual' | 'whatsapp'
  provider: string | null
  provider_contact_id: string | null
  contact_phone_e164: string | null
  contact_name_snapshot: string | null
  patient_id: string | null
  status: ConversationStatus
  assigned_to: string | null
  last_message_at: string | null
  last_inbound_at: string | null
  last_outbound_at: string | null
  version: number
  created_at: string
  updated_at: string
}

interface EmbeddedLastMessage {
  body: string
  direction: 'inbound' | 'outbound'
}

interface ConversationRowWithEmbeds extends ConversationRow {
  patients: { id: string; name: string; phone: string } | null
  messages: EmbeddedLastMessage[]
}

interface MessageRow {
  id: string
  clinic_id: string
  conversation_id: string
  channel: 'manual' | 'whatsapp'
  direction: 'inbound' | 'outbound'
  body: string
  occurred_at: string
  author_user_id: string | null
  author_name_snapshot: string | null
  recorded_by_user_id: string | null
  recorded_by_name_snapshot: string | null
  provider: string | null
  provider_message_id: string | null
  delivery_status: Message['deliveryStatus']
  created_at: string
}

interface EventRow {
  id: string
  event_type: ConversationEventType
  actor_name_snapshot: string | null
  actor_role_snapshot: ClinicRole | null
  metadata: Record<string, unknown> | null
  created_at: string
}

/* =============================================================================
   Colunas

   Listadas uma vez e reutilizadas. `select('*')` traria colunas novas para o
   cliente no dia em que uma migration as criar, sem ninguem decidir isso.
   ========================================================================== */

const CONVERSATION_COLUMNS =
  'id, clinic_id, channel, provider, provider_contact_id, contact_phone_e164, ' +
  'contact_name_snapshot, patient_id, status, assigned_to, last_message_at, ' +
  'last_inbound_at, last_outbound_at, version, created_at, updated_at'

/**
 * A lista inteira numa consulta so.
 *
 * `messages` embutido com `limit 1` por conversa e `order desc` resolve o
 * preview sem N+1 — o PostgREST aplica o limite por linha-pai, atravessando a
 * FK composta (clinic_id, conversation_id). Verificado contra o banco real
 * antes de este codigo existir; sem isso, uma pagina de 30 conversas custaria
 * 31 consultas.
 */
const LIST_SELECT = `${CONVERSATION_COLUMNS}, patients ( id, name, phone ), messages ( body, direction )`

const MESSAGE_COLUMNS =
  'id, clinic_id, conversation_id, channel, direction, body, occurred_at, ' +
  'author_user_id, author_name_snapshot, recorded_by_user_id, ' +
  'recorded_by_name_snapshot, provider, provider_message_id, delivery_status, created_at'

const EVENT_COLUMNS = 'id, event_type, actor_name_snapshot, actor_role_snapshot, metadata, created_at'

/* =============================================================================
   Conversao
   ========================================================================== */

function toDetailBase(row: ConversationRow) {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    channel: row.channel,
    provider: row.provider,
    providerContactId: row.provider_contact_id,
    contactPhoneE164: row.contact_phone_e164,
    contactNameSnapshot: row.contact_name_snapshot,
    patientId: row.patient_id,
    status: row.status,
    assignedTo: row.assigned_to,
    lastMessageAt: row.last_message_at,
    lastInboundAt: row.last_inbound_at,
    lastOutboundAt: row.last_outbound_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    conversationId: row.conversation_id,
    channel: row.channel,
    direction: row.direction,
    body: row.body,
    occurredAt: row.occurred_at,
    authorUserId: row.author_user_id,
    authorNameSnapshot: row.author_name_snapshot,
    recordedByUserId: row.recorded_by_user_id,
    recordedByNameSnapshot: row.recorded_by_name_snapshot,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
  }
}

/**
 * Filtra `metadata` pela lista branca.
 *
 * `metadata` e jsonb. Hoje guarda exatamente o que as funcoes de controle
 * escrevem, mas um adaptador de provedor pode passar a gravar payload bruto
 * ali. Repassar o objeto inteiro faria desse dia um vazamento, sem uma linha
 * de codigo mudando aqui. Lista branca inverte o default: o que for novo fica
 * de fora ate alguem decidir o contrario.
 */
function safeMetadata(raw: Record<string, unknown> | null): ConversationEventMetadata {
  if (!raw) return {}
  const saida: ConversationEventMetadata = {}
  for (const chave of CONVERSATION_EVENT_METADATA_KEYS) {
    if (Object.hasOwn(raw, chave)) saida[chave] = raw[chave]
  }
  return saida
}

/**
 * Forma que as funcoes do banco devolvem para uma mensagem.
 *
 * NAO e igual ao DTO `Message`, e por isso este tipo existe separado:
 * `message_row_json` emite `authorName`/`recordedByName` (sem o sufixo
 * `Snapshot`) e nao emite `provider` nem `providerMessageId`. Repassar o objeto
 * cru faria o POST devolver uma forma diferente do GET para a MESMA entidade —
 * e a tela teria que saber de onde o dado veio para saber como le-lo.
 */
interface MessageRpcJson {
  id: string
  clinicId: string
  conversationId: string
  channel: 'manual' | 'whatsapp'
  direction: 'inbound' | 'outbound'
  body: string
  occurredAt: string
  authorUserId: string | null
  authorName: string | null
  recordedByUserId: string | null
  recordedByName: string | null
  deliveryStatus: Message['deliveryStatus']
  createdAt: string
}

function rpcToMessage(raw: MessageRpcJson): Message {
  return {
    id: raw.id,
    clinicId: raw.clinicId,
    conversationId: raw.conversationId,
    channel: raw.channel,
    direction: raw.direction,
    body: raw.body,
    occurredAt: raw.occurredAt,
    authorUserId: raw.authorUserId,
    authorNameSnapshot: raw.authorName,
    recordedByUserId: raw.recordedByUserId,
    recordedByNameSnapshot: raw.recordedByName,
    /*
     * Nulos por CONSTRAINT, nao por suposicao: `messages_channel_provider_check`
     * exige provider nulo quando o canal e manual, e este caminho so cria
     * mensagem manual. Nenhum registro manual carrega id de provedor porque
     * nenhum provedor foi acionado.
     */
    provider: null,
    providerMessageId: null,
    deliveryStatus: raw.deliveryStatus,
    createdAt: raw.createdAt,
  }
}

const PREVIEW_MAX = 140

/** Uma linha, sem quebras, curta. A lista mostra um gostinho, nao o texto. */
function preview(body: string): string {
  const limpo = body.replace(/\s+/g, ' ').trim()
  return limpo.length <= PREVIEW_MAX ? limpo : `${limpo.slice(0, PREVIEW_MAX - 1)}…`
}

/* =============================================================================
   Servico
   ========================================================================== */

@Injectable()
export class ConversationsService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  /**
   * Fila da clinica.
   *
   * CUSTO: 2 consultas, independente do tamanho da pagina. A primeira traz as
   * conversas com paciente e ultima mensagem embutidos; a segunda resolve os
   * nomes dos responsaveis. Nenhuma delas cresce com o numero de linhas.
   */
  async list(
    clinicId: string,
    userId: string,
    query: ListConversationsQuery,
  ): Promise<Page<ConversationListItem>> {
    let q = this.supabase
      .from('conversations')
      .select(LIST_SELECT)
      .eq('clinic_id', clinicId)
      // O embed traz a ULTIMA mensagem: uma so, a mais recente.
      .order('occurred_at', { referencedTable: 'messages', ascending: false })
      .limit(1, { referencedTable: 'messages' })

    if (query.status) q = q.eq('status', query.status)
    if (query.patientId) q = q.eq('patient_id', query.patientId)

    // `mine` nunca vem do cliente: sai do JWT ja validado.
    if (query.assignment === 'mine') q = q.eq('assigned_to', userId)
    if (query.assignment === 'unassigned') q = q.is('assigned_to', null)

    if (query.q) q = q.or(buildSearchFilter(query.q))
    if (query.cursor) q = q.or(queueCursorFilter(decodeQueueCursor(query.cursor)))

    // Uma linha a mais do que o pedido: e assim que sabemos se ha proxima
    // pagina sem pagar um count() em toda requisicao.
    const { data, error } = await q
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('id', { ascending: false })
      .limit(query.limit + 1)

    if (error) throw mapPostgrestError(error)

    const rows = (data ?? []) as unknown as ConversationRowWithEmbeds[]
    const temMais = rows.length > query.limit
    const pagina = temMais ? rows.slice(0, query.limit) : rows

    const nomes = await this.resolveAssigneeNames(
      clinicId,
      pagina.map((r) => r.assigned_to),
    )

    const items = pagina.map((row): ConversationListItem => {
      const ultima = row.messages[0] ?? null
      return {
        id: row.id,
        channel: row.channel,
        status: row.status,
        assignedTo: row.assigned_to,
        assignedToName: row.assigned_to ? (nomes.get(row.assigned_to) ?? null) : null,
        assignedToIsMe: row.assigned_to === userId,
        patientId: row.patient_id,
        patientName: row.patients?.name ?? null,
        contactPhoneE164: row.contact_phone_e164,
        contactNameSnapshot: row.contact_name_snapshot,
        lastMessageAt: row.last_message_at,
        lastMessagePreview: ultima ? preview(ultima.body) : null,
        lastMessageDirection: ultima?.direction ?? null,
        needsReply: needsReply({
          lastInboundAt: row.last_inbound_at,
          lastOutboundAt: row.last_outbound_at,
        }),
        version: row.version,
        updatedAt: row.updated_at,
      }
    })

    const ultimo = pagina.at(-1)
    return {
      items,
      nextCursor:
        temMais && ultimo
          ? encodeQueueCursor({ lastMessageAt: ultimo.last_message_at, id: ultimo.id })
          : null,
    }
  }

  /**
   * Ausencia tratada aqui, explicitamente: conversa inexistente e conversa de
   * outro tenant produzem o MESMO 404, com o mesmo corpo. Confirmar a
   * existencia de um recurso alheio ja e vazar informacao sobre ele.
   */
  async findById(clinicId: string, userId: string, id: string): Promise<ConversationDetail> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select(`${CONVERSATION_COLUMNS}, patients ( id, name, phone )`)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Conversa nao encontrada.')

    const row = data as unknown as ConversationRow & {
      patients: { id: string; name: string; phone: string } | null
    }

    const [nomes, nextAppointment] = await Promise.all([
      this.resolveAssigneeNames(clinicId, [row.assigned_to]),
      this.findNextAppointment(clinicId, row.patient_id),
    ])

    return {
      ...toDetailBase(row),
      assignedToName: row.assigned_to ? (nomes.get(row.assigned_to) ?? null) : null,
      assignedToIsMe: row.assigned_to === userId,
      patient: row.patients
        ? { id: row.patients.id, name: row.patients.name, phone: row.patients.phone }
        : null,
      nextAppointment,
      needsReply: needsReply({
        lastInboundAt: row.last_inbound_at,
        lastOutboundAt: row.last_outbound_at,
      }),
    }
  }

  /**
   * Thread, em ordem cronologica.
   *
   * Paginada desde o primeiro dia: uma conversa de WhatsApp com meses de
   * historico nao cabe numa resposta, e descobrir isso em producao seria tarde.
   */
  async listMessages(
    clinicId: string,
    conversationId: string,
    query: PaginationQuery,
  ): Promise<Page<Message>> {
    await this.assertConversationVisible(clinicId, conversationId)

    let q = this.supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('conversation_id', conversationId)

    if (query.cursor) q = q.or(timeCursorFilter('occurred_at', decodeTimeCursor(query.cursor)))

    const { data, error } = await q
      .order('occurred_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(query.limit + 1)

    if (error) throw mapPostgrestError(error)

    const rows = (data ?? []) as unknown as MessageRow[]
    const temMais = rows.length > query.limit
    const pagina = temMais ? rows.slice(0, query.limit) : rows
    const ultimo = pagina.at(-1)

    return {
      items: pagina.map(toMessage),
      nextCursor:
        temMais && ultimo ? encodeTimeCursor({ at: ultimo.occurred_at, id: ultimo.id }) : null,
    }
  }

  /** Auditoria da conversa, em ordem cronologica. */
  async listEvents(
    clinicId: string,
    conversationId: string,
    query: PaginationQuery,
  ): Promise<Page<ConversationEventView>> {
    await this.assertConversationVisible(clinicId, conversationId)

    let q = this.supabase
      .from('conversation_events')
      .select(EVENT_COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('conversation_id', conversationId)

    if (query.cursor) q = q.or(timeCursorFilter('created_at', decodeTimeCursor(query.cursor)))

    const { data, error } = await q
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(query.limit + 1)

    if (error) throw mapPostgrestError(error)

    const rows = (data ?? []) as unknown as EventRow[]
    const temMais = rows.length > query.limit
    const pagina = temMais ? rows.slice(0, query.limit) : rows
    const ultimo = pagina.at(-1)

    return {
      items: pagina.map((row) => ({
        id: row.id,
        eventType: row.event_type,
        actorNameSnapshot: row.actor_name_snapshot,
        actorRoleSnapshot: row.actor_role_snapshot,
        createdAt: row.created_at,
        metadata: safeMetadata(row.metadata),
      })),
      nextCursor:
        temMais && ultimo ? encodeTimeCursor({ at: ultimo.created_at, id: ultimo.id }) : null,
    }
  }

  /* -------------------------------------------------------------------------
     ESCRITA

     A API nao faz INSERT. `authenticated` tem apenas SELECT nas tres tabelas,
     e cada escrita entra por uma funcao controlada — a mesma barreira de que o
     Bloco 1 ja dependia para ler com seguranca.
  ------------------------------------------------------------------------- */

  /**
   * Registra uma conversa MANUAL.
   *
   * A clinica vem do header ja validado pelo guard, nunca do corpo. Canal,
   * provider, status, responsavel, versao e timestamps sao decididos dentro de
   * `conversation_create_manual` — nao existe parametro para forja-los.
   */
  async register(
    clinicId: string,
    input: RegisterConversationInput,
  ): Promise<RegisterConversationResult> {
    const telefone = normalizarTelefone(input.contactPhone)

    const { data, error } = await this.supabase.rpc('conversation_create_manual', {
      p_clinic_id: clinicId,
      p_contact_phone_e164: telefone,
      p_contact_name_snapshot: input.contactName ?? null,
      p_patient_id: input.patientId ?? null,
    })

    if (error) throw mapPostgrestError(error)

    const resultado = data as { outcome: string; conversation?: Conversation }

    switch (resultado.outcome) {
      case 'ok':
        return { created: true, conversation: resultado.conversation! }
      /*
       * Telefone que ja tem thread NAO e erro. A atendente quer falar com
       * aquela pessoa; devolver 409 obrigaria a tela a tratar uma falha para
       * fazer exatamente o que o usuario pediu. Ela recebe a conversa que ja
       * existe e abre.
       */
      case 'exists':
        return { created: false, conversation: resultado.conversation! }
      /*
       * A clinica do header nao e do usuario. Na pratica o guard barrou antes;
       * se chegou aqui, a resposta continua sendo a de recurso inexistente —
       * nunca "existe, mas nao e sua".
       */
      case 'not_found':
        throw new NotFoundException('Clinica nao encontrada.')
      default:
        throw new InternalServerErrorException('Erro ao processar a requisicao.')
    }
  }

  /**
   * REGISTRA uma mensagem manual. NAO ENVIA NADA.
   *
   * O modo manual anota no sistema algo que aconteceu por fora — telefone,
   * balcao, WhatsApp pessoal. Nenhum provedor e acionado e nenhuma entrega e
   * prometida; por isso `delivery_status` fica nulo, garantido por CHECK.
   *
   * A API tambem nao monta snapshot de autoria: quem carimba `author_*` e
   * `recorded_by_*` e o trigger, a partir de `auth.uid()`. Nao ha caminho pelo
   * qual o cliente informe quem falou.
   */
  async registerManualMessage(
    clinicId: string,
    conversationId: string,
    input: RegisterManualMessageInput,
  ): Promise<RegisterManualMessageResult> {
    const { data, error } = await this.supabase.rpc('conversation_add_manual_message', {
      p_conversation_id: conversationId,
      p_direction: input.direction,
      p_body: input.body,
      p_occurred_at: input.occurredAt ?? null,
    })

    if (error) throw mapPostgrestError(error)

    const resultado = data as { outcome: string; message?: MessageRpcJson }

    switch (resultado.outcome) {
      case 'ok':
        break
      /*
       * Conversa inexistente e conversa de outro tenant chegam aqui como o
       * MESMO outcome e saem como o mesmo 404 — a funcao no banco ja tomou
       * esse cuidado, e a API nao o desfaz.
       */
      case 'not_found':
        throw new NotFoundException('Conversa nao encontrada.')
      /*
       * Conversa de canal externo: a mensagem precisaria ser entregue de
       * verdade, e este caminho nao entrega nada. A resposta nao diz de que
       * canal se trata — para quem nao pode ver a conversa, isso ja seria
       * informacao sobre ela.
       */
      case 'not_manual':
        throw new BadRequestException('Esta conversa nao aceita registro manual.')
      case 'invalid_body':
        throw new BadRequestException('Mensagem vazia.')
      default:
        throw new InternalServerErrorException('Erro ao processar a requisicao.')
    }

    /*
     * A conversa volta junto porque uma mensagem inbound PODE reabrir uma
     * conversa resolvida, por trigger. Sem esse estado, a tela mostraria
     * "resolvida" logo depois de algo que a reabriu, e so descobriria no
     * proximo refresh.
     *
     * Custa uma consulta a mais no servidor e economiza um ida-e-volta HTTP do
     * navegador pelo Funnel, que o Bloco 1 mediu em ~250ms de mediana. Nao e
     * endpoint agregado: e o estado do proprio recurso que esta requisicao
     * acabou de alterar.
     */
    const { data: conversa, error: erroConversa } = await this.supabase
      .from('conversations')
      .select(CONVERSATION_COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('id', conversationId)
      .maybeSingle()

    if (erroConversa) throw mapPostgrestError(erroConversa)
    if (!conversa) throw new NotFoundException('Conversa nao encontrada.')

    return {
      message: rpcToMessage(resultado.message!),
      conversation: toDetailBase(conversa as unknown as ConversationRow),
    }
  }

  // ---------------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------------

  /**
   * Sub-recurso de conversa invisivel responde 404, igual ao id inexistente.
   *
   * Sem esta checagem, `/conversations/<id de outro tenant>/messages` devolveria
   * uma lista vazia com 200 — indistinguivel de uma conversa real e sem
   * mensagens, mas confirmando ao cliente que aquele caminho e valido.
   */
  private async assertConversationVisible(clinicId: string, conversationId: string): Promise<void> {
    const { data, error } = await this.supabase
      .from('conversations')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('id', conversationId)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Conversa nao encontrada.')
  }

  /**
   * Nome de quem atende, para os ids desta pagina — UMA consulta, nunca uma por
   * linha.
   *
   * POR QUE VEM DA AUDITORIA E NAO DE `profiles`: a policy de `profiles` e
   * `id = auth.uid()`, entao ninguem le o nome de um colega, e `clinic_members`
   * nao guarda nome. O que existe hoje sao os snapshots que as proprias funcoes
   * de controle gravam em `conversation_events` — dados que este usuario ja
   * pode ler, da clinica dele.
   *
   * LIMITACAO ASSUMIDA: quem nunca agiu na clinica nao tem snapshot, e o nome
   * sai nulo. Por isso o DTO carrega `assignedToIsMe` separado, que nunca
   * depende disso. A correcao de verdade e uma coluna de snapshot em
   * `conversations`, gravada no assign/transfer — mudanca de banco, fora deste
   * bloco.
   */
  private async resolveAssigneeNames(
    clinicId: string,
    ids: (string | null)[],
  ): Promise<Map<string, string>> {
    const alvos = [...new Set(ids.filter((id): id is string => id !== null))]
    const nomes = new Map<string, string>()
    if (alvos.length === 0) return nomes

    const { data, error } = await this.supabase
      .from('conversation_events')
      .select('actor_user_id, actor_name_snapshot, created_at')
      .eq('clinic_id', clinicId)
      .in('actor_user_id', alvos)
      .not('actor_name_snapshot', 'is', null)
      .order('created_at', { ascending: false })
      .limit(alvos.length * 20)

    if (error) throw mapPostgrestError(error)

    // Ordenado do mais recente para o mais antigo: o primeiro que aparece por
    // usuario e o snapshot mais novo que temos dele.
    for (const linha of (data ?? []) as { actor_user_id: string; actor_name_snapshot: string }[]) {
      if (!nomes.has(linha.actor_user_id)) nomes.set(linha.actor_user_id, linha.actor_name_snapshot)
    }
    return nomes
  }

  /**
   * Proxima consulta futura do paciente vinculado.
   *
   * Uma consulta, so quando ha paciente. Cancelados ficam de fora: "proxima
   * consulta" e um compromisso que ainda vale, nao o proximo registro na tabela.
   */
  private async findNextAppointment(
    clinicId: string,
    patientId: string | null,
  ): Promise<ConversationNextAppointment | null> {
    if (!patientId) return null

    const { data, error } = await this.supabase
      .from('appointments')
      .select(
        'id, starts_at, ends_at, status, professionals ( name ), services ( name )',
      )
      .eq('clinic_id', clinicId)
      .eq('patient_id', patientId)
      .gte('starts_at', new Date().toISOString())
      .neq('status', 'cancelled')
      .order('starts_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) return null

    const row = data as unknown as {
      id: string
      starts_at: string
      ends_at: string
      status: ConversationNextAppointment['status']
      professionals: { name: string } | null
      services: { name: string } | null
    }

    return {
      id: row.id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.status,
      professionalName: row.professionals?.name ?? null,
      serviceName: row.services?.name ?? null,
    }
  }
}

/**
 * Busca livre em nome de contato e telefone.
 *
 * O termo vai para um filtro do PostgREST, entao virgula e parentese sao
 * sintaxe e precisam sair — senao `a,b` viraria uma condicao extra. Nao e
 * full-text: e `ilike` em duas colunas, que e o que a v0.1 pediu.
 *
 * Digitos tambem sao casados contra o telefone sem formatacao, para que quem
 * digita "98765" ache "+5511987654321".
 */
/**
 * Telefone digitado -> E.164, com `toE164BR` como UNICA autoridade.
 *
 * Nao ha uma segunda regra aqui, de proposito. `toE164BR` devolve null sempre
 * que nao da para ter certeza do pais, inclusive para numeros estrangeiros que
 * ja chegam com "+": um "+1 415 555 0100" NAO pode virar "+5514155550100",
 * porque o telefone e a identidade da thread e isso poria duas pessoas
 * diferentes na mesma conversa. Preferimos recusar a adivinhar.
 *
 * CONSEQUENCIA ACEITA NA v0.1: numero estrangeiro nao e cadastravel por este
 * caminho. E limitacao de produto conhecida, nao acidente.
 */
function normalizarTelefone(bruto: string | null | undefined): string | null {
  if (bruto === null || bruto === undefined || bruto.trim() === '') return null

  const normalizado = toE164BR(bruto)
  if (normalizado === null) {
    throw new BadRequestException('Telefone invalido. Informe um numero brasileiro valido.')
  }
  return normalizado
}

function buildSearchFilter(termo: string): string {
  const limpo = termo.replace(/[(),*\\]/g, ' ').trim()
  if (limpo.length === 0) return 'id.is.null'

  const condicoes = [`contact_name_snapshot.ilike.*${limpo}*`]
  const digitos = limpo.replace(/\D/g, '')
  if (digitos.length >= 3) condicoes.push(`contact_phone_e164.ilike.*${digitos}*`)
  else condicoes.push(`contact_phone_e164.ilike.*${limpo}*`)

  return condicoes.join(',')
}
