import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Ambiente ADMINISTRATIVO. Este arquivo e o unico lugar do repositorio que
 * conhece a service_role — ela nao existe em apps/web nem em apps/api.
 */
export interface IsolationEnv {
  url: string
  anonKey: string
  serviceRoleKey: string
  apiUrl: string
}

/** Ambientes onde este teste pode rodar. Producao NUNCA entra nesta lista. */
const ALLOWED_ENVIRONMENTS = ['development', 'staging'] as const

export function loadIsolationEnv(): IsolationEnv {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const apiUrl = process.env.API_URL ?? 'http://localhost:3333'
  const environment = process.env.SUPABASE_TEST_ENVIRONMENT

  const missing = [
    ['SUPABASE_URL', url],
    ['SUPABASE_ANON_KEY', anonKey],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(
      `Faltam variaveis no .env.test: ${missing.join(', ')}. ` +
        'Copie .env.test.example e preencha com as credenciais do seu projeto Supabase.',
    )
  }

  /**
   * Trava de ambiente.
   *
   * Este teste cria e apaga usuarios com service_role. Exigir a declaracao
   * explicita do ambiente evita que uma variavel apontando para producao
   * (herdada do shell, copiada por engano) rode aqui sem ninguem perceber.
   * A ausencia da variavel e tratada como recusa, nao como default permissivo.
   */
  if (!environment || !ALLOWED_ENVIRONMENTS.includes(environment as never)) {
    throw new Error(
      `SUPABASE_TEST_ENVIRONMENT deve ser ${ALLOWED_ENVIRONMENTS.join(' ou ')} ` +
        `(recebido: ${environment ?? 'nao definido'}).\n` +
        'Este teste cria e remove usuarios reais e NUNCA deve rodar contra producao.',
    )
  }

  return { url: url!, anonKey: anonKey!, serviceRoleKey: serviceRoleKey!, apiUrl }
}

/** Client administrativo: IGNORA RLS. Usado so para montar e desmontar o cenario. */
export function createAdminClient(env: IsolationEnv): SupabaseClient {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Client anonimo, sem sessao. Representa um atacante sem credencial. */
export function createAnonClient(env: IsolationEnv): SupabaseClient {
  return createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// ---------------------------------------------------------------------------
// Registro de recursos criados
// ---------------------------------------------------------------------------

const MANIFEST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '.runs')

export interface RunManifest {
  testRunId: string
  createdAt: string
  supabaseUrl: string
  userIds: string[]
  clinicIds: string[]
}

/**
 * Rastreia o que ESTA execucao criou, para que a limpeza seja sempre por ID.
 *
 * Cada registro e persistido em disco na hora — antes de qualquer coisa poder
 * falhar. Assim, mesmo que o processo seja morto no meio, sobra um manifesto
 * com os IDs exatos, e a limpeza posterior nunca precisa procurar por nome.
 *
 * Decisao deliberada: NAO existe varredura inicial do banco. Buscar residuo por
 * `like`, prefixo ou `delete where name...` pode alcancar dado legitimo. Preferimos
 * deixar residuo de teste e oferecer `pnpm test:isolation:cleanup <test_run_id>`.
 */
export class TestResourceRegistry {
  readonly testRunId: string
  private readonly userIds: string[] = []
  private readonly clinicIds: string[] = []
  private readonly manifestPath: string

  constructor(private readonly supabaseUrl: string) {
    this.testRunId = randomUUID()
    this.manifestPath = join(MANIFEST_DIR, `${this.testRunId}.json`)
    mkdirSync(MANIFEST_DIR, { recursive: true })
    this.persist()
  }

  registerUser(userId: string): void {
    this.userIds.push(userId)
    this.persist()
  }

  registerClinic(clinicId: string): void {
    this.clinicIds.push(clinicId)
    this.persist()
  }

  private persist(): void {
    const manifest: RunManifest = {
      testRunId: this.testRunId,
      createdAt: new Date().toISOString(),
      supabaseUrl: this.supabaseUrl,
      userIds: [...this.userIds],
      clinicIds: [...this.clinicIds],
    }
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  }

  /**
   * Remove SOMENTE os IDs desta execucao, na ordem correta.
   *
   * clinics.created_by e ON DELETE SET NULL, entao apagar o usuario NAO apaga a
   * clinica nem os pacientes. Primeiro as clinicas (que cascateiam pacientes e
   * memberships), depois os usuarios.
   *
   * O manifesto so e removido se tudo saiu; qualquer sobra mantem o arquivo para
   * a limpeza manual.
   */
  async cleanup(admin: SupabaseClient): Promise<void> {
    const problems: string[] = []

    if (this.clinicIds.length > 0) {
      const { error } = await admin.from('clinics').delete().in('id', this.clinicIds)
      if (error) problems.push(`clinicas: ${error.message}`)
    }

    for (const userId of this.userIds) {
      const { error } = await admin.auth.admin.deleteUser(userId)
      if (error) problems.push(`usuario ${userId}: ${error.message}`)
    }

    if (problems.length > 0) {
      console.error(
        `Limpeza incompleta da execucao ${this.testRunId}:\n  ${problems.join('\n  ')}\n` +
          `Manifesto preservado em ${this.manifestPath}\n` +
          `Rode: pnpm test:isolation:cleanup ${this.testRunId}`,
      )
      return
    }

    rmSync(this.manifestPath, { force: true })
  }
}

export function readManifest(testRunId: string): RunManifest {
  const path = join(MANIFEST_DIR, `${testRunId}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as RunManifest
}

export { MANIFEST_DIR }

// ---------------------------------------------------------------------------
// Montagem do cenario
// ---------------------------------------------------------------------------

export interface TestActor {
  userId: string
  email: string
  accessToken: string
  /** Client com o JWT do usuario: sujeito ao RLS, exatamente como a API real. */
  db: SupabaseClient
  clinicId: string
  clinicName: string
  patientId: string
  patientName: string
}

/**
 * Cria um usuario ja confirmado, loga, cria a clinica dele pela RPC e um paciente.
 *
 * Cada recurso e registrado no registry IMEDIATAMENTE apos ser criado, antes do
 * proximo passo poder falhar. Se a criacao da clinica quebrar, o usuario ja esta
 * no manifesto e sera removido — a falha parcial nao vaza recurso.
 *
 * `email_confirm: true` evita depender da configuracao de confirmacao por e-mail
 * do projeto, que travaria o teste sem relacao com isolamento.
 * O test_run_id vai no user_metadata para tornar a origem rastreavel no painel.
 */
export async function createActor(
  env: IsolationEnv,
  admin: SupabaseClient,
  registry: TestResourceRegistry,
  label: string,
): Promise<TestActor> {
  const runId = registry.testRunId
  const email = `rls-${label}-${runId}@example.test`
  const password = `Senha-Teste-${runId}!`

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: `Usuario ${label.toUpperCase()}`,
      test_run_id: runId,
      purpose: 'recurso efemero do teste de isolamento',
    },
  })
  if (createError || !created.user) {
    throw new Error(`Falha ao criar usuario ${label}: ${createError?.message}`)
  }
  registry.registerUser(created.user.id)

  const db = createAnonClient(env)
  const { data: session, error: signInError } = await db.auth.signInWithPassword({
    email,
    password,
  })
  if (signInError || !session.session) {
    throw new Error(`Falha ao logar usuario ${label}: ${signInError?.message}`)
  }

  const clinicName = `Clinica ${label.toUpperCase()} ${runId}`
  const { data: clinic, error: clinicError } = await db
    .rpc('create_clinic_with_owner', { p_name: clinicName })
    .single<{ id: string }>()
  if (clinicError || !clinic) {
    throw new Error(`Falha ao criar clinica de ${label}: ${clinicError?.message}`)
  }
  registry.registerClinic(clinic.id)

  const patientName = `Paciente ${label.toUpperCase()} ${runId}`
  const { data: patient, error: patientError } = await db
    .from('patients')
    .insert({ clinic_id: clinic.id, name: patientName, phone: '11988887777' })
    .select('id')
    .single<{ id: string }>()
  if (patientError || !patient) {
    throw new Error(`Falha ao criar paciente de ${label}: ${patientError?.message}`)
  }
  // O paciente nao precisa de registro proprio: cascateia junto com a clinica.

  return {
    userId: created.user.id,
    email,
    accessToken: session.session.access_token,
    db,
    clinicId: clinic.id,
    clinicName,
    patientId: patient.id,
    patientName,
  }
}
