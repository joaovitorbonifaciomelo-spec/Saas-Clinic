/**
 * =============================================================================
 * REGRESSAO PERMANENTE — ClinicMembershipGuard COM MAIS DE UM MEMBRO
 * =============================================================================
 *
 * POR QUE ESTE ARQUIVO EXISTE SOZINHO
 *
 * O guard consultava `clinic_members` filtrando so por `clinic_id`. A policy da
 * tabela e `is_clinic_member(clinic_id)`, ou seja, o usuario enxerga TODOS os
 * colegas da clinica dele — nao apenas a propria linha. Com dois funcionarios a
 * consulta devolvia duas linhas, `maybeSingle()` virava erro, e o guard
 * respondia 403 em TODA rota de TODO modulo.
 *
 * A falha estava latente desde a fundacao porque nenhuma suite tinha clinica
 * com mais de um membro. Ela apareceu por acaso, quando o cenario do Atendimento
 * precisou de um segundo membro para testar o filtro `unassigned`.
 *
 * Um cenario que so existe por acaso some no dia em que alguem reescreve a
 * fixture que o criava. Este arquivo torna a condicao explicita: uma clinica com
 * DOIS membros e a unica razao de ele existir.
 *
 * O escopo e proposital: rotas ANTIGAS (fundacao e agenda) junto das novas. O
 * bug nunca foi do Atendimento — era do guard, que todo modulo usa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

let env: IsolationEnv
let admin: SupabaseClient
let registry: TestResourceRegistry

/** Dona da clinica A. */
let alice: TestActor
/** SEGUNDO membro da MESMA clinica — a condicao que o bug exigia. */
let bruno: { userId: string; accessToken: string }
/** Outra clinica, para o isolamento continuar provado. */
let carlos: TestActor

let conversaA = ''

/**
 * Uma rota de cada modulo que usa o guard.
 *
 * `/me` fica de fora: ele nao passa pelo ClinicMembershipGuard, e incluir uma
 * rota que nao exercita o alvo daria falsa sensacao de cobertura.
 */
const ROTAS_COM_GUARD = [
  '/api/patients',
  '/api/professionals',
  '/api/services',
  '/api/appointments',
  '/api/conversations',
] as const

async function api(path: string, token: string, clinicId: string) {
  const response = await fetch(`${env.apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-clinic-id': clinicId,
      'Content-Type': 'application/json',
    },
  })
  return { status: response.status, body: await response.text() }
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)

  const saude = await fetch(`${env.apiUrl}/api/health`).catch(() => null)
  if (saude?.ok !== true) {
    throw new Error(`API precisa estar no ar em ${env.apiUrl} para estes testes.`)
  }

  alice = await createActor(env, admin, registry, 'guard-a')
  carlos = await createActor(env, admin, registry, 'guard-c')

  // Bruno entra na clinica de Alice. E este INSERT que reproduz o bug.
  const email = `guard-b-${registry.testRunId}@example.test`
  const password = `Senha-Teste-${registry.testRunId}!`
  const { data: criado, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Usuario BRUNO', test_run_id: registry.testRunId },
  })
  if (error || !criado.user) throw new Error(`bruno: ${error?.message}`)
  registry.registerUser(criado.user.id)
  await admin
    .from('clinic_members')
    .insert({ clinic_id: alice.clinicId, user_id: criado.user.id, role: 'attendant' })

  const db = createAnonClient(env)
  const { data: sessao } = await db.auth.signInWithPassword({ email, password })
  bruno = { userId: criado.user.id, accessToken: sessao!.session!.access_token }

  const { data: conversa } = await alice.db.rpc('conversation_create_manual', {
    p_clinic_id: alice.clinicId,
    p_contact_phone_e164: null,
    p_contact_name_snapshot: 'Contato do guard',
    p_patient_id: null,
  })
  conversaA = (conversa as { conversation: { id: string } }).conversation.id
}, 240_000)

afterAll(async () => {
  if (registry) await registry.cleanup(admin)
}, 120_000)

describe('clinica com dois membros', () => {
  it('a clinica realmente tem dois membros — a premissa do teste', async () => {
    // Se esta afirmacao cair, todas as outras deste arquivo viram tautologia:
    // passariam com uma clinica de um membro so, que e exatamente o cenario
    // que escondia o bug.
    const { data } = await admin
      .from('clinic_members')
      .select('user_id')
      .eq('clinic_id', alice.clinicId)
    expect(data).toHaveLength(2)
    expect(data!.map((m) => m.user_id).sort()).toEqual([alice.userId, bruno.userId].sort())
  })

  it.each(ROTAS_COM_GUARD)('a DONA da clinica acessa %s', async (rota) => {
    const r = await api(rota, alice.accessToken, alice.clinicId)
    expect(r.status, `${rota} -> ${r.body.slice(0, 120)}`).toBe(200)
  })

  it.each(ROTAS_COM_GUARD)('o SEGUNDO membro tambem acessa %s', async (rota) => {
    // Este e o caso que voltava 403: com dois membros visiveis, o guard
    // quebrava para os dois, nao so para o recem-chegado.
    const r = await api(rota, bruno.accessToken, alice.clinicId)
    expect(r.status, `${rota} -> ${r.body.slice(0, 120)}`).toBe(200)
  })

  it.each(ROTAS_COM_GUARD)('quem e de outra clinica continua negado em %s', async (rota) => {
    const r = await api(rota, carlos.accessToken, alice.clinicId)
    expect(r.status).toBe(403)
  })

  it('os dois membros enxergam o MESMO recurso da clinica', async () => {
    const deAlice = await api(`/api/conversations/${conversaA}`, alice.accessToken, alice.clinicId)
    const deBruno = await api(`/api/conversations/${conversaA}`, bruno.accessToken, alice.clinicId)

    expect(deAlice.status).toBe(200)
    expect(deBruno.status).toBe(200)
    expect(JSON.parse(deBruno.body).id).toBe(conversaA)
  })

  it('o guard nao depende de a clinica ter um unico membro', async () => {
    // Terceiro membro: se a consulta do guard voltasse a nao filtrar por
    // usuario, `maybeSingle()` quebraria de novo — e agora com tres linhas.
    const email = `guard-d-${registry.testRunId}@example.test`
    const password = `Senha-Teste-${registry.testRunId}!`
    const { data: criado } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Usuario DANI', test_run_id: registry.testRunId },
    })
    registry.registerUser(criado!.user!.id)
    await admin
      .from('clinic_members')
      .insert({ clinic_id: alice.clinicId, user_id: criado!.user!.id, role: 'attendant' })

    const db = createAnonClient(env)
    const { data: sessao } = await db.auth.signInWithPassword({ email, password })
    const token = sessao!.session!.access_token

    for (const rota of ROTAS_COM_GUARD) {
      expect((await api(rota, token, alice.clinicId)).status, rota).toBe(200)
    }
    // E os antigos seguem funcionando.
    expect((await api('/api/patients', alice.accessToken, alice.clinicId)).status).toBe(200)
    expect((await api('/api/patients', bruno.accessToken, alice.clinicId)).status).toBe(200)
  })

  it('membership removido derruba o acesso, sem afetar quem ficou', async () => {
    await admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', alice.clinicId)
      .eq('user_id', bruno.userId)

    expect((await api('/api/patients', bruno.accessToken, alice.clinicId)).status).toBe(403)
    // A dona nao pode ser afetada pela saida do colega.
    expect((await api('/api/patients', alice.accessToken, alice.clinicId)).status).toBe(200)

    await admin
      .from('clinic_members')
      .insert({ clinic_id: alice.clinicId, user_id: bruno.userId, role: 'attendant' })
    expect((await api('/api/patients', bruno.accessToken, alice.clinicId)).status).toBe(200)
  })
})
