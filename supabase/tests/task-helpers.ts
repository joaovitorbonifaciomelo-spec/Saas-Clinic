/**
 * Cenario compartilhado das suites de Pendencias, contra o Supabase real.
 *
 * Nao existe API de Pendencias ainda — por decisao, esta rodada e so de banco.
 * Entao os testes chamam as RPCs pelo cliente `authenticated`, com o JWT do
 * usuario, que e exatamente o caminho que a API vai usar depois. O que estes
 * testes exercitam e o mesmo RLS e o mesmo controle de concorrencia.
 */
import { afterAll, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createActor,
  createAdminClient,
  createAnonClient,
  loadIsolationEnv,
  TestResourceRegistry,
  type IsolationEnv,
  type TestActor,
} from './helpers'

export const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000'

export interface Colega {
  userId: string
  email: string
  /** JWT do colega: os testes de API precisam dos DOIS lados de cada corrida. */
  accessToken: string
  db: SupabaseClient
}

export interface Cenario {
  env: IsolationEnv
  admin: SupabaseClient
  registry: TestResourceRegistry
  /** Dona da clinica A. */
  maria: TestActor
  /** Segundo membro da clinica A — os dois lados de toda corrida. */
  joao: Colega
  /** Clinica B, para o isolamento continuar sendo provado e nao presumido. */
  bruno: TestActor
}

/**
 * Acrescenta um membro a uma clinica que ja existe.
 *
 * `clinic_members` nao tem policy de INSERT — de proposito, desde a fundacao —
 * entao o vinculo e criado com a chave administrativa, que e o papel do setup
 * de teste. O restante da suite roda como `authenticated`.
 */
export async function adicionarMembro(
  env: IsolationEnv,
  admin: SupabaseClient,
  registry: TestResourceRegistry,
  clinicId: string,
  rotulo: string,
): Promise<Colega> {
  const email = `task-${rotulo}-${registry.testRunId}@example.test`
  const password = `Senha-Teste-${registry.testRunId}!`

  const { data: criado, error: erroCriar } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: `Colega ${rotulo.toUpperCase()}`,
      test_run_id: registry.testRunId,
      purpose: 'recurso efemero dos testes de pendencias',
    },
  })
  if (erroCriar || !criado.user) throw new Error(`criar ${rotulo}: ${erroCriar?.message}`)
  registry.registerUser(criado.user.id)

  const { error: erroVinculo } = await admin
    .from('clinic_members')
    .insert({ clinic_id: clinicId, user_id: criado.user.id, role: 'attendant' })
  if (erroVinculo) throw new Error(`vincular ${rotulo}: ${erroVinculo.message}`)

  const db = createAnonClient(env)
  const { data: sessao, error: erroLogin } = await db.auth.signInWithPassword({ email, password })
  if (erroLogin || !sessao.session) throw new Error(`logar ${rotulo}: ${erroLogin?.message}`)

  return { userId: criado.user.id, email, accessToken: sessao.session.access_token, db }
}

export async function montarCenario(): Promise<Cenario> {
  const env = loadIsolationEnv()
  const admin = createAdminClient(env)
  const registry = new TestResourceRegistry(env.url)

  const maria = await createActor(env, admin, registry, 'maria')
  const bruno = await createActor(env, admin, registry, 'bruno')
  const joao = await adicionarMembro(env, admin, registry, maria.clinicId, 'joao')

  return { env, admin, registry, maria, joao, bruno }
}

/* =============================================================================
   Chamadas as RPCs
   ========================================================================== */

export interface TaskRow {
  id: string
  clinicId: string
  title: string
  description: string | null
  status: 'open' | 'completed' | 'cancelled'
  assignedTo: string | null
  dueAt: string | null
  patientId: string | null
  conversationId: string | null
  appointmentId: string | null
  createdBy: string | null
  completedBy: string | null
  completedAt: string | null
  cancelledBy: string | null
  cancelledAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface Resultado {
  outcome: 'ok' | 'conflict' | 'not_found' | 'invalid_state' | 'patient_mismatch'
  reason?: string
  task?: TaskRow
}

export async function rpc(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<Resultado> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as Resultado
}

export interface CriarArgs {
  title?: string
  description?: string | null
  dueAt?: string | null
  assignee?: string | null
  patientId?: string | null
  conversationId?: string | null
  appointmentId?: string | null
}

export const criarTask = (db: SupabaseClient, clinicId: string, args: CriarArgs = {}) =>
  rpc(db, 'task_create', {
    p_clinic_id: clinicId,
    p_title: args.title ?? 'Ligar para confirmar horario',
    p_description: args.description ?? null,
    p_due_at: args.dueAt ?? null,
    p_assignee_id: args.assignee ?? null,
    p_patient_id: args.patientId ?? null,
    p_conversation_id: args.conversationId ?? null,
    p_appointment_id: args.appointmentId ?? null,
  })

/** Atalho: cria e devolve a tarefa, falhando alto se a criacao nao foi ok. */
export async function novaTask(
  db: SupabaseClient,
  clinicId: string,
  args: CriarArgs = {},
): Promise<TaskRow> {
  const r = await criarTask(db, clinicId, args)
  if (r.outcome !== 'ok' || !r.task) {
    throw new Error(`criacao inesperada: ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`)
  }
  return r.task
}

export const assumir = (db: SupabaseClient, t: TaskRow) =>
  rpc(db, 'task_assign', { p_task_id: t.id, p_expected_version: t.version })

export const transferir = (db: SupabaseClient, t: TaskRow, para: string) =>
  rpc(db, 'task_transfer', {
    p_task_id: t.id,
    p_expected_version: t.version,
    p_to_user_id: para,
  })

export const devolver = (db: SupabaseClient, t: TaskRow) =>
  rpc(db, 'task_release', { p_task_id: t.id, p_expected_version: t.version })

export const definirPrazo = (db: SupabaseClient, t: TaskRow, dueAt: string | null) =>
  rpc(db, 'task_set_due', {
    p_task_id: t.id,
    p_expected_version: t.version,
    p_due_at: dueAt,
  })

export const concluir = (db: SupabaseClient, t: TaskRow) =>
  rpc(db, 'task_complete', { p_task_id: t.id, p_expected_version: t.version })

export const cancelar = (db: SupabaseClient, t: TaskRow) =>
  rpc(db, 'task_cancel', { p_task_id: t.id, p_expected_version: t.version })

export const reabrir = (db: SupabaseClient, t: TaskRow) =>
  rpc(db, 'task_reopen', { p_task_id: t.id, p_expected_version: t.version })

export const editar = (
  db: SupabaseClient,
  t: TaskRow,
  campos: { title?: string; description?: string | null; setDescription?: boolean },
) =>
  rpc(db, 'task_update_details', {
    p_task_id: t.id,
    p_expected_version: t.version,
    p_title: campos.title ?? null,
    p_description: campos.description ?? null,
    p_set_description: campos.setDescription ?? false,
  })

/* =============================================================================
   Leituras de apoio
   ========================================================================== */

export interface EventoRow {
  event_type: string
  actor_user_id: string | null
  actor_name_snapshot: string | null
  actor_role_snapshot: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export async function eventosDe(
  admin: SupabaseClient,
  taskId: string,
): Promise<EventoRow[]> {
  const { data, error } = await admin
    .from('task_events')
    .select('event_type, actor_user_id, actor_name_snapshot, actor_role_snapshot, metadata, created_at')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })
    .order('event_type', { ascending: true })
  if (error) throw new Error(`eventos: ${error.message}`)
  return (data ?? []) as EventoRow[]
}

/** Estado bruto da linha, lido com a chave administrativa (ignora RLS). */
export async function lerTask(admin: SupabaseClient, taskId: string) {
  const { data, error } = await admin.from('tasks').select('*').eq('id', taskId).maybeSingle()
  if (error) throw new Error(`ler task: ${error.message}`)
  return data as (Record<string, unknown> & { version: number }) | null
}

/* =============================================================================
   Encerramento da suite
   ========================================================================== */

/**
 * Registra a limpeza do cenario e decide o destino do manifesto.
 *
 * A suite chama isto no topo, e nao escreve `afterAll` proprio. Duas razoes:
 * a decisao sobre o manifesto fica num lugar so, e a deteccao de falha usa
 * `afterEach`, cujo contexto (`{ task }`) e API publica e estavel — o `suite`
 * como argumento de `afterAll` mudou de posicao entre versoes do vitest e
 * quebrou silenciosamente ao ser usado assim.
 *
 * Falha em qualquer teste marca o estado como INCERTO: um teste que quebrou no
 * meio pode ter criado recurso fora do registry, e ai o manifesto e o unico
 * ponto de partida para achar o que sobrou.
 */
export function registrarLimpeza(obterCenario: () => Cenario | undefined): void {
  let algumaFalhou = false

  afterEach(({ task }) => {
    if (task.result?.state === 'fail') algumaFalhou = true
  })

  afterAll(async () => {
    const cenario = obterCenario()
    if (!cenario) return
    await cenario.registry.cleanup(cenario.admin, { estadoIncerto: algumaFalhou })
  }, 120_000)
}
