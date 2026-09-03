import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
import {
  TASK_CONFLICT_ERROR,
  TASK_INVALID_REASON_LABELS,
  TASK_INVALID_STATE_ERROR,
  TASK_PATIENT_MISMATCH_ERROR,
  dayBoundsInTimezone,
  parseTaskEventMetadata,
  type ClinicRole,
  type AssignTaskInput,
  type ChangeTaskDueInput,
  type CreateTaskInput,
  type ListTasksQuery,
  type Page,
  type PaginationQuery,
  type Task,
  type TaskConflictResponse,
  type TaskControlInput,
  type TaskDetail,
  type TaskInvalidReason,
  type TaskInvalidStateResponse,
  type TaskEventType,
  type TaskEventView,
  type TaskListItem,
  type TaskPatientMismatchResponse,
  type TaskStatus,
  type TransferTaskInput,
  type UpdateTaskDetailsInput,
} from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'
import {
  decodeDueCursor,
  decodeTimeCursor,
  dueCursorFilter,
  encodeDueCursor,
  encodeTimeCursor,
  timeCursorFilter,
  timeCursorFilterDesc,
} from './task-cursor'

/* =============================================================================
   Linhas do banco
   ========================================================================== */

interface TaskRow {
  id: string
  clinic_id: string
  title: string
  description: string | null
  status: TaskStatus
  assigned_to: string | null
  due_at: string | null
  patient_id: string | null
  conversation_id: string | null
  appointment_id: string | null
  created_by: string | null
  completed_by: string | null
  completed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  version: number
  created_at: string
  updated_at: string
}

interface PatientEmbed {
  id: string
  name: string
  phone: string
}

interface ConversationEmbed {
  id: string
  status: string
  contact_name_snapshot: string | null
  contact_phone_e164: string | null
}

interface AppointmentEmbed {
  id: string
  starts_at: string
  status: string
  professionals: { name: string } | null
}

interface TaskRowWithPatient extends TaskRow {
  patients: PatientEmbed | null
}

interface TaskRowWithContext extends TaskRowWithPatient {
  conversations: ConversationEmbed | null
  appointments: AppointmentEmbed | null
}

/** Forma uniforme que TODAS as nove RPCs devolvem. */
interface RpcResultado {
  outcome: string
  reason?: TaskInvalidReason
  task?: Task
}

interface EventRow {
  id: string
  event_type: TaskEventType
  actor_user_id: string | null
  actor_name_snapshot: string | null
  actor_role_snapshot: ClinicRole | null
  metadata: Record<string, unknown> | null
  created_at: string
}

/* =============================================================================
   Colunas

   Listadas uma vez. `select('*')` entregaria ao cliente qualquer coluna que uma
   migration futura criar, sem ninguem decidir isso.
   ========================================================================== */

const TASK_COLUMNS =
  'id, clinic_id, title, description, status, assigned_to, due_at, ' +
  'patient_id, conversation_id, appointment_id, created_by, ' +
  'completed_by, completed_at, cancelled_by, cancelled_at, version, created_at, updated_at'

/**
 * A lista inteira numa consulta so.
 *
 * `patients` embutido atravessa a FK COMPOSTA (clinic_id, patient_id). Sem o
 * embed, uma pagina de 50 pendencias custaria 51 consultas — e o nome do
 * paciente e justamente o que faz alguem reconhecer a pendencia na lista.
 *
 * Conversa e agendamento NAO entram aqui: a lista mostra apenas que o contexto
 * existe (pelo id), e resolver os dois resumos multiplicaria o payload por algo
 * que a linha nao exibe.
 */
const LIST_SELECT = `${TASK_COLUMNS}, patients ( id, name, phone )`

/**
 * Detalhe: os tres contextos resolvidos na MESMA consulta, incluindo o
 * profissional do agendamento, que e um segundo salto de embed.
 */
const DETAIL_SELECT =
  `${TASK_COLUMNS}, patients ( id, name, phone ), ` +
  'conversations ( id, status, contact_name_snapshot, contact_phone_e164 ), ' +
  'appointments ( id, starts_at, status, professionals ( name ) )'

const EVENT_COLUMNS =
  'id, event_type, actor_user_id, actor_name_snapshot, actor_role_snapshot, metadata, created_at'

/* =============================================================================
   Conversao
   ========================================================================== */

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignedTo: row.assigned_to,
    dueAt: row.due_at,
    patientId: row.patient_id,
    conversationId: row.conversation_id,
    appointmentId: row.appointment_id,
    createdBy: row.created_by,
    completedBy: row.completed_by,
    completedAt: row.completed_at,
    cancelledBy: row.cancelled_by,
    cancelledAt: row.cancelled_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

@Injectable()
export class TasksService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  /* ---------------------------------------------------------------- lista */

  /**
   * Duas consultas, sempre — para uma pendencia ou para cem.
   *
   *   1. a pagina, com o paciente embutido;
   *   2. o diretorio de membros, para o nome ATUAL do responsavel.
   *
   * A segunda e pulada quando a pagina inteira esta sem responsavel e nao ha
   * filtro por responsavel, que e o caso da fila geral.
   */
  async list(
    clinicId: string,
    userId: string,
    timezone: string,
    query: ListTasksQuery,
    agora: Date = new Date(),
  ): Promise<Page<TaskListItem>> {
    const { startOfToday, startOfTomorrow } = dayBoundsInTimezone(timezone, agora)

    /*
     * O filtro por responsavel explicito e validado contra o diretorio da
     * clinica ativa. Sem isso, um id de outra clinica devolveria uma lista
     * vazia — tecnicamente seguro, porque o RLS ja escopa tudo, mas mentiroso:
     * a tela mostraria "nenhuma pendencia" onde a resposta certa e "esse
     * responsavel nao e daqui".
     */
    let diretorio: Map<string, string | null> | null = null
    if (query.assigneeId) {
      diretorio = await this.memberDirectory(clinicId)
      if (!diretorio.has(query.assigneeId)) {
        throw new BadRequestException('assigneeId nao e membro da clinica ativa.')
      }
    }

    let q = this.supabase
      .from('tasks')
      .select(LIST_SELECT)
      .eq('clinic_id', clinicId)
      .eq('status', query.status)

    // `mine` sai do JWT ja validado, nunca de um parametro da URL.
    if (query.assignment === 'mine') q = q.eq('assigned_to', userId)
    if (query.assignment === 'unassigned') q = q.is('assigned_to', null)
    if (query.assigneeId) q = q.eq('assigned_to', query.assigneeId)

    switch (query.due) {
      case 'overdue':
        q = q.lt('due_at', startOfToday.toISOString())
        break
      case 'today':
        q = q
          .gte('due_at', startOfToday.toISOString())
          .lt('due_at', startOfTomorrow.toISOString())
        break
      case 'upcoming':
        q = q.gte('due_at', startOfTomorrow.toISOString())
        break
      case 'none':
        q = q.is('due_at', null)
        break
      case 'any':
        break
    }

    q = this.applyOrder(q, query)

    // Uma linha a mais do que o pedido: e assim que sabemos se ha proxima
    // pagina sem pagar um count() em toda requisicao.
    const { data, error } = await q.limit(query.limit + 1)
    if (error) throw mapPostgrestError(error)

    const rows = (data ?? []) as unknown as TaskRowWithPatient[]
    const temMais = rows.length > query.limit
    const pagina = temMais ? rows.slice(0, query.limit) : rows

    if (!diretorio && pagina.some((r) => r.assigned_to !== null)) {
      diretorio = await this.memberDirectory(clinicId)
    }

    const items = pagina.map((row): TaskListItem => {
      const responsavel = row.assigned_to
      return {
        id: row.id,
        title: row.title,
        status: row.status,
        dueAt: row.due_at,
        isPastDueNow: row.due_at !== null && row.status === 'open' && row.due_at < agora.toISOString(),
        assignedTo: responsavel,
        assignee: responsavel
          ? { userId: responsavel, displayName: diretorio?.get(responsavel) ?? null }
          : null,
        isMine: responsavel === userId,
        patientId: row.patient_id,
        patient: row.patients
          ? { id: row.patients.id, name: row.patients.name, phone: row.patients.phone }
          : null,
        conversationId: row.conversation_id,
        appointmentId: row.appointment_id,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    })

    return { items, nextCursor: temMais ? this.nextCursor(pagina.at(-1)!, query) : null }
  }

  /* -------------------------------------------------------------- detalhe */

  async findById(
    clinicId: string,
    userId: string,
    id: string,
    agora: Date = new Date(),
  ): Promise<TaskDetail> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select(DETAIL_SELECT)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    // Pendencia de outra clinica nao chega aqui: o RLS ja a esconde, e o
    // resultado e o MESMO de um uuid inexistente. Um 403 confirmaria que ela
    // existe.
    if (!data) throw new NotFoundException('Pendencia nao encontrada.')

    const row = data as unknown as TaskRowWithContext
    const diretorio = row.assigned_to ? await this.memberDirectory(clinicId) : null

    return {
      ...toTask(row),
      isPastDueNow: row.due_at !== null && row.status === 'open' && row.due_at < agora.toISOString(),
      assignee: row.assigned_to
        ? { userId: row.assigned_to, displayName: diretorio?.get(row.assigned_to) ?? null }
        : null,
      isMine: row.assigned_to === userId,
      patient: row.patients
        ? { id: row.patients.id, name: row.patients.name, phone: row.patients.phone }
        : null,
      conversation: row.conversations
        ? {
            id: row.conversations.id,
            status: row.conversations.status,
            contactName: row.conversations.contact_name_snapshot,
            contactPhoneE164: row.conversations.contact_phone_e164,
          }
        : null,
      appointment: row.appointments
        ? {
            id: row.appointments.id,
            startsAt: row.appointments.starts_at,
            status: row.appointments.status,
            professionalName: row.appointments.professionals?.name ?? null,
          }
        : null,
    }
  }

  /* --------------------------------------------------------------- eventos */

  async listEvents(
    clinicId: string,
    taskId: string,
    query: PaginationQuery,
  ): Promise<Page<TaskEventView>> {
    /*
     * A existencia e conferida antes, e nao inferida de "zero eventos".
     *
     * Toda pendencia nasce com um evento `created`, entao lista vazia HOJE
     * significa que a pendencia nao existe ou nao e desta clinica. Depender
     * disso amarraria o 404 a um detalhe do modelo de eventos: no dia em que
     * algum evento deixasse de nascer, o endpoint passaria a devolver 200 vazio
     * para uma pendencia inexistente, sem nenhuma linha de codigo mudar aqui.
     */
    const { data: existe, error: erroExiste } = await this.supabase
      .from('tasks')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('id', taskId)
      .maybeSingle()

    if (erroExiste) throw mapPostgrestError(erroExiste)
    if (!existe) throw new NotFoundException('Pendencia nao encontrada.')

    let q = this.supabase
      .from('task_events')
      .select(EVENT_COLUMNS)
      // clinic_id SEMPRE no filtro, junto com task_id. O RLS ja escopa, mas a
      // camada de dados nao deve depender disso sozinha.
      .eq('clinic_id', clinicId)
      .eq('task_id', taskId)

    if (query.cursor) {
      q = q.or(timeCursorFilterDesc('created_at', decodeTimeCursor(query.cursor)))
    }

    const { data, error } = await q
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(query.limit + 1)

    if (error) throw mapPostgrestError(error)

    const rows = (data ?? []) as unknown as EventRow[]
    const temMais = rows.length > query.limit
    const pagina = temMais ? rows.slice(0, query.limit) : rows

    const items = pagina.map((row): TaskEventView => {
      const validada = parseTaskEventMetadata(row.event_type, row.metadata ?? {})
      if (!validada.ok) {
        /*
         * Invariante quebrada, e nao dado do usuario: o banco so aceita metadata
         * que passa pelos CHECKs, e as RPCs sao as unicas que escrevem. Se
         * chegou algo fora do formato, alguem escreveu por fora — mascarar
         * devolvendo `{}` esconderia exatamente isso.
         *
         * O conteudo NAO entra na mensagem: ele pode carregar nome de pessoa.
         */
        throw new InternalServerErrorException(
          `Evento ${row.id} tem metadata incompativel com o tipo ${row.event_type}.`,
        )
      }
      return {
        id: row.id,
        eventType: row.event_type,
        actorUserId: row.actor_user_id,
        actorNameSnapshot: row.actor_name_snapshot,
        actorRoleSnapshot: row.actor_role_snapshot,
        metadata: validada.metadata,
        createdAt: row.created_at,
      }
    })

    const ultimo = pagina.at(-1)
    return {
      items,
      nextCursor:
        temMais && ultimo ? encodeTimeCursor({ at: ultimo.created_at, id: ultimo.id }) : null,
    }
  }


  /* =========================================================================
     Escrita — todas passam por RPC controlada

     A API nunca faz INSERT ou UPDATE direto, e NUNCA insere em `task_events`.
     `authenticated` sequer tem o privilegio: o banco e a autoridade, e o evento
     nasce como consequencia atomica da mesma transacao da RPC. Duplicar a
     auditoria aqui criaria uma segunda fonte de verdade capaz de discordar.
     ====================================================================== */

  async create(
    clinicId: string,
    userId: string,
    input: CreateTaskInput,
    agora: Date = new Date(),
  ): Promise<TaskDetail> {
    const resultado = await this.rpc('task_create', {
      p_clinic_id: clinicId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_due_at: input.dueAt ?? null,
      p_assignee_id: input.assignedTo ?? null,
      p_patient_id: input.patientId ?? null,
      p_conversation_id: input.conversationId ?? null,
      p_appointment_id: input.appointmentId ?? null,
    })

    const task = this.desempacotar(resultado, 'Pendencia nao encontrada.')
    // Reconsulta para devolver o MESMO read model do GET: a RPC entrega a linha
    // crua, sem paciente nem nome do responsavel resolvidos. Duas ondas na
    // criacao, que acontece uma vez por pendencia.
    return this.findById(clinicId, userId, task.id, agora)
  }

  updateDetails(id: string, input: UpdateTaskDetailsInput): Promise<Task> {
    return this.controlar('task_update_details', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
      p_title: input.title ?? null,
      p_description: input.description ?? null,
      /*
       * O flag separa "nao mexer na descricao" de "apagar a descricao". Sem
       * ele, `null` seria ambiguo entre as duas intencoes, e apagar uma
       * descricao por engano e o tipo de perda que ninguem percebe na hora.
       */
      p_set_description: Object.hasOwn(input, 'description'),
    })
  }

  /**
   * Atribuir uma pendencia da fila geral a um membro EXPLICITO.
   *
   * `auth.uid()` continua sendo quem EXECUTA; `assigneeId` e quem RECEBE — duas
   * responsabilidades diferentes, e o evento `assigned` registra as duas
   * separadamente.
   *
   * O destinatario e validado contra `clinic_members` DENTRO da RPC. A API nao
   * e a unica guarda: uma checagem que so existe aqui vale enquanto todo mundo
   * passar por aqui.
   */
  assign(id: string, input: AssignTaskInput): Promise<Task> {
    return this.controlar('task_assign', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
      p_assignee_id: input.assigneeId,
    })
  }

  transfer(id: string, input: TransferTaskInput): Promise<Task> {
    return this.controlar('task_transfer', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
      p_to_user_id: input.assigneeId,
    })
  }

  release(id: string, input: TaskControlInput): Promise<Task> {
    return this.controlar('task_release', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
    })
  }

  setDue(id: string, input: ChangeTaskDueInput): Promise<Task> {
    return this.controlar('task_set_due', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
      p_due_at: input.dueAt,
    })
  }

  complete(id: string, input: TaskControlInput): Promise<Task> {
    return this.controlar('task_complete', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
    })
  }

  cancel(id: string, input: TaskControlInput): Promise<Task> {
    return this.controlar('task_cancel', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
    })
  }

  reopen(id: string, input: TaskControlInput): Promise<Task> {
    return this.controlar('task_reopen', {
      p_task_id: id,
      p_expected_version: input.expectedVersion,
    })
  }

  /* ------------------------------------------------ traducao de outcome */

  private async rpc(fn: string, args: Record<string, unknown>): Promise<RpcResultado> {
    const { data, error } = await this.supabase.rpc(fn, args)
    if (error) {
      /*
       * 23503 so pode vir das FKs de contexto ou do responsavel. A mensagem e
       * generica de proposito: distinguir "nao existe" de "e de outra clinica"
       * ja seria revelar a existencia.
       */
      if (error.code === '23503') {
        throw new NotFoundException('Referencia informada nao encontrada.')
      }
      throw mapPostgrestError(error)
    }
    return data as RpcResultado
  }

  /** Uma chamada, uma traducao. Toda operacao de controle passa por aqui. */
  private async controlar(fn: string, args: Record<string, unknown>): Promise<Task> {
    return this.desempacotar(await this.rpc(fn, args), 'Pendencia nao encontrada.')
  }

  /**
   * Traduz o `outcome` do banco em resposta HTTP.
   *
   * Um lugar so, para as nove operacoes: se cada rota traduzisse por conta
   * propria, bastaria uma esquecer o `reason` para a tela passar a mandar
   * recarregar numa situacao em que recarregar nao resolve.
   */
  private desempacotar(resultado: RpcResultado, mensagemNaoEncontrado: string): Task {
    switch (resultado.outcome) {
      case 'ok':
        return resultado.task!

      case 'conflict':
        throw new ConflictException({
          statusCode: 409,
          error: TASK_CONFLICT_ERROR,
          message: 'Esta pendencia foi alterada por outra pessoa.',
          current: resultado.task!,
        } satisfies TaskConflictResponse)

      /*
       * 409 tambem, e a distincao e o ponto. Conflito pede "recarregue e decida
       * de novo"; este pede outra ACAO — reabrir, transferir, assumir. Mandar
       * recarregar aqui faria a pessoa ver o mesmo estado e tentar de novo.
       */
      case 'invalid_state':
        throw new ConflictException({
          statusCode: 409,
          error: TASK_INVALID_STATE_ERROR,
          reason: resultado.reason!,
          message: TASK_INVALID_REASON_LABELS[resultado.reason!],
          current: resultado.task!,
        } satisfies TaskInvalidStateResponse)

      /*
       * Sem `current`: a pendencia nem chegou a existir. O erro acontece na
       * validacao de coerencia, antes de qualquer INSERT.
       */
      case 'patient_mismatch':
        throw new ConflictException({
          statusCode: 409,
          error: TASK_PATIENT_MISMATCH_ERROR,
          message: 'Esta conversa ja esta vinculada a outro paciente.',
        } satisfies TaskPatientMismatchResponse)

      /*
       * Inexistente, de outro tenant, ou vinculo perdido durante a corrida. O
       * ultimo caso importa: `task_conflict` revalida o membership antes de
       * devolver estado, entao quem acabou de perder o acesso recebe 404 e NAO
       * um 409 com o conteudo da pendencia.
       */
      case 'not_found':
        throw new NotFoundException(mensagemNaoEncontrado)

      default:
        // Outcome que o shared nao conhece: o banco mudou e a API nao. Melhor
        // 500 alto do que traduzir para algo que a tela interpretaria errado.
        throw new InternalServerErrorException('Erro ao processar a requisicao.')
    }
  }

  /* ------------------------------------------------------------ ordenacao */

  /**
   * Ordenacao deterministica, com `id` como desempate obrigatorio.
   *
   * Sem o desempate, duas pendencias com o mesmo prazo poderiam trocar de lugar
   * entre duas paginas — e o keyset perderia ou repetiria linhas sem erro
   * nenhum aparecer.
   */
  private applyOrder<T>(q: T, query: ListTasksQuery): T {
    type Ordenavel = {
      order: (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => Ordenavel
      or: (f: string) => Ordenavel
    }
    let b = q as unknown as Ordenavel

    if (query.status === 'completed' || query.status === 'cancelled') {
      const coluna = query.status === 'completed' ? 'completed_at' : 'cancelled_at'
      if (query.cursor) b = b.or(timeCursorFilterDesc(coluna, decodeTimeCursor(query.cursor)))
      return b.order(coluna, { ascending: false }).order('id', { ascending: false }) as unknown as T
    }

    // Aberta e sem prazo: mais ANTIGA primeiro, para uma pendencia sem data nao
    // ficar enterrada sob as recem-criadas.
    if (query.due === 'none') {
      if (query.cursor) b = b.or(timeCursorFilter('created_at', decodeTimeCursor(query.cursor)))
      return b.order('created_at', { ascending: true }).order('id', { ascending: true }) as unknown as T
    }

    /*
     * `due_at asc nulls last, id asc` — a mesma ordem do indice
     * (clinic_id, status, due_at, id), entao os recortes overdue/today/upcoming
     * e a fila completa saem sem sort.
     *
     * Com due=any isso ja apresenta atrasadas -> hoje -> proximas -> sem prazo,
     * que e exatamente a leitura que a recepcao faz de cima para baixo.
     */
    if (query.cursor) b = b.or(dueCursorFilter(decodeDueCursor(query.cursor)))
    return b
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true }) as unknown as T
  }

  private nextCursor(ultimo: TaskRow, query: ListTasksQuery): string {
    if (query.status === 'completed') {
      return encodeTimeCursor({ at: ultimo.completed_at!, id: ultimo.id })
    }
    if (query.status === 'cancelled') {
      return encodeTimeCursor({ at: ultimo.cancelled_at!, id: ultimo.id })
    }
    if (query.due === 'none') {
      return encodeTimeCursor({ at: ultimo.created_at, id: ultimo.id })
    }
    return encodeDueCursor({ dueAt: ultimo.due_at, id: ultimo.id })
  }

  /* ----------------------------------------------------------- diretorio */

  /**
   * Nome ATUAL dos membros, pelo read model seguro.
   *
   * `clinic_member_directory` le `profiles` por dentro, como SECURITY DEFINER,
   * depois de validar o membership de quem pergunta. E o que permite mostrar o
   * nome de um colega sem ampliar a policy de `profiles`, que continua
   * restrita ao proprio usuario.
   */
  private async memberDirectory(clinicId: string): Promise<Map<string, string | null>> {
    const { data, error } = await this.supabase.rpc('clinic_member_directory', {
      p_clinic_id: clinicId,
    })
    if (error) throw mapPostgrestError(error)

    const mapa = new Map<string, string | null>()
    for (const m of (data ?? []) as { user_id: string; display_name: string | null }[]) {
      mapa.set(m.user_id, m.display_name)
    }
    return mapa
  }
}
