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

export function loadIsolationEnv(): IsolationEnv {
  const url = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const apiUrl = process.env.API_URL ?? 'http://localhost:3333'

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
 * `email_confirm: true` evita depender da configuracao de confirmacao por e-mail
 * do projeto, que travaria o teste sem relacao com isolamento.
 */
export async function createActor(
  env: IsolationEnv,
  admin: SupabaseClient,
  label: string,
  runId: string,
): Promise<TestActor> {
  const email = `rls-${label}-${runId}@example.test`
  const password = `Senha-Teste-${runId}!`
  const fullName = `Usuario ${label.toUpperCase()}`

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (createError || !created.user) {
    throw new Error(`Falha ao criar usuario ${label}: ${createError?.message}`)
  }

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

  const patientName = `Paciente ${label.toUpperCase()} ${runId}`
  const { data: patient, error: patientError } = await db
    .from('patients')
    .insert({ clinic_id: clinic.id, name: patientName, phone: '11988887777' })
    .select('id')
    .single<{ id: string }>()
  if (patientError || !patient) {
    throw new Error(`Falha ao criar paciente de ${label}: ${patientError?.message}`)
  }

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

/**
 * Teardown na ORDEM CERTA.
 *
 * clinics.created_by e ON DELETE SET NULL, entao apagar o usuario NAO apaga a
 * clinica nem os pacientes. Primeiro as clinicas (que cascateiam pacientes e
 * memberships), depois os usuarios. Inverter a ordem deixaria clinicas orfas
 * acumulando a cada execucao.
 */
export async function teardown(
  admin: SupabaseClient,
  clinicIds: string[],
  userIds: string[],
): Promise<void> {
  if (clinicIds.length > 0) {
    await admin.from('clinics').delete().in('id', clinicIds)
  }
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId)
  }
}

/** Remove sobras de execucoes anteriores que tenham sido interrompidas. */
export async function cleanupLeftovers(admin: SupabaseClient): Promise<void> {
  const { data } = await admin.from('clinics').select('id').like('name', 'Clinica _ rlstest-%')
  if (data && data.length > 0) {
    await admin
      .from('clinics')
      .delete()
      .in(
        'id',
        data.map((row) => row.id as string),
      )
  }
}
