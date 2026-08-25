/**
 * =============================================================================
 * TESTE OBRIGATORIO DE ISOLAMENTO ENTRE CLINICAS
 * =============================================================================
 *
 * Cenario:
 *   Usuario A -> Clinica A -> Paciente A
 *   Usuario B -> Clinica B -> Paciente B
 *
 * Criterio de aceite: A enxerga somente o Paciente A, B somente o Paciente B, e
 * requisicao manual com o id do paciente alheio e negada PELO BANCO.
 *
 * Os clients usados nas assercoes carregam o JWT real de cada usuario, entao
 * quem responde e o RLS do Postgres - nao a camada de aplicacao. A service_role
 * aparece apenas no setup/teardown, jamais numa assercao.
 *
 * Requer .env.test preenchido e as migrations aplicadas.
 * Os testes de nivel API sao pulados automaticamente se a API nao estiver no ar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  cleanupLeftovers,
  createActor,
  createAdminClient,
  createAnonClient,
  loadIsolationEnv,
  teardown,
  type IsolationEnv,
  type TestActor,
} from './helpers'

const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000'

let env: IsolationEnv
let admin: SupabaseClient
let alice: TestActor
let bob: TestActor
let apiOnline = false

async function apiGet(
  path: string,
  token: string,
  clinicId?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (clinicId) headers['x-clinic-id'] = clinicId
  const response = await fetch(`${env.apiUrl}${path}`, { headers })
  return { status: response.status, body: await response.text() }
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  await cleanupLeftovers(admin)

  const runId = `rlstest-${Date.now()}`
  alice = await createActor(env, admin, 'a', runId)
  bob = await createActor(env, admin, 'b', runId)

  try {
    const health = await fetch(`${env.apiUrl}/api/health`)
    apiOnline = health.ok
  } catch {
    apiOnline = false
  }
}, 120_000)

afterAll(async () => {
  if (admin) {
    await teardown(
      admin,
      [alice?.clinicId, bob?.clinicId].filter(Boolean) as string[],
      [alice?.userId, bob?.userId].filter(Boolean) as string[],
    )
  }
}, 120_000)

// ---------------------------------------------------------------------------
describe('1. Leitura de pacientes e restrita a propria clinica', () => {
  it('A lista apenas o Paciente A', async () => {
    const { data, error } = await alice.db.from('patients').select('id, name')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(alice.patientId)
    expect(data!.map((r) => r.name)).not.toContain(bob.patientName)
  })

  it('B lista apenas o Paciente B', async () => {
    const { data, error } = await bob.db.from('patients').select('id, name')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(bob.patientId)
    expect(data!.map((r) => r.name)).not.toContain(alice.patientName)
  })

  it('A pedindo explicitamente o id do Paciente B recebe vazio', async () => {
    const { data, error } = await alice.db
      .from('patients')
      .select('id, name')
      .eq('id', bob.patientId)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('A filtrando pelo clinic_id da Clinica B recebe vazio', async () => {
    const { data, error } = await alice.db
      .from('patients')
      .select('id')
      .eq('clinic_id', bob.clinicId)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe('2. Escrita cruzada entre tenants e negada', () => {
  it('A nao consegue alterar o Paciente B', async () => {
    const { data } = await alice.db
      .from('patients')
      .update({ name: 'INVADIDO POR A' })
      .eq('id', bob.patientId)
      .select('id')
    expect(data ?? []).toHaveLength(0)

    // Confirmado do lado de B: o nome continua intacto.
    const { data: check } = await bob.db.from('patients').select('name').eq('id', bob.patientId)
    expect(check![0]!.name).toBe(bob.patientName)
  })

  it('A nao consegue excluir o Paciente B', async () => {
    await alice.db.from('patients').delete().eq('id', bob.patientId)
    const { data: check } = await bob.db.from('patients').select('id').eq('id', bob.patientId)
    expect(check).toHaveLength(1)
  })

  it('A nao consegue inserir paciente na Clinica B', async () => {
    const { error } = await alice.db
      .from('patients')
      .insert({ clinic_id: bob.clinicId, name: 'Infiltrado', phone: '11911112222' })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  it('A nao consegue mover o proprio paciente para a Clinica B', async () => {
    const { error } = await alice.db
      .from('patients')
      .update({ clinic_id: bob.clinicId })
      .eq('id', alice.patientId)
    expect(error).not.toBeNull()

    const { data: check } = await alice.db
      .from('patients')
      .select('clinic_id')
      .eq('id', alice.patientId)
    expect(check![0]!.clinic_id).toBe(alice.clinicId)
  })
})

// ---------------------------------------------------------------------------
describe('3. Clinicas e memberships tambem sao isolados', () => {
  it('A enxerga apenas a Clinica A', async () => {
    const { data } = await alice.db.from('clinics').select('id, name')
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(alice.clinicId)
  })

  it('A pedindo o id da Clinica B recebe vazio', async () => {
    const { data } = await alice.db.from('clinics').select('id').eq('id', bob.clinicId)
    expect(data).toHaveLength(0)
  })

  it('A enxerga apenas o proprio membership', async () => {
    const { data } = await alice.db.from('clinic_members').select('clinic_id, user_id, role')
    expect(data).toHaveLength(1)
    expect(data![0]!.clinic_id).toBe(alice.clinicId)
    expect(data![0]!.user_id).toBe(alice.userId)
    expect(data![0]!.role).toBe('admin')
  })

  it('A nao enxerga o perfil de B', async () => {
    const { data } = await alice.db.from('profiles').select('id').eq('id', bob.userId)
    expect(data).toHaveLength(0)
  })

  it('A nao consegue renomear a Clinica B', async () => {
    const { data } = await alice.db
      .from('clinics')
      .update({ name: 'INVADIDA' })
      .eq('id', bob.clinicId)
      .select('id')
    expect(data ?? []).toHaveLength(0)

    const { data: check } = await bob.db.from('clinics').select('name').eq('id', bob.clinicId)
    expect(check![0]!.name).toBe(bob.clinicName)
  })
})

// ---------------------------------------------------------------------------
describe('4. clinic_members e somente leitura: ninguem se auto-adiciona', () => {
  it('A nao consegue se adicionar a Clinica B', async () => {
    const { error } = await alice.db
      .from('clinic_members')
      .insert({ clinic_id: bob.clinicId, user_id: alice.userId, role: 'admin' })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
  })

  it('A nao consegue se adicionar nem a propria clinica de novo', async () => {
    const { error } = await alice.db
      .from('clinic_members')
      .insert({ clinic_id: alice.clinicId, user_id: alice.userId, role: 'admin' })
    expect(error).not.toBeNull()
  })

  it('A nao consegue alterar o proprio papel', async () => {
    const { data } = await alice.db
      .from('clinic_members')
      .update({ role: 'professional' })
      .eq('clinic_id', alice.clinicId)
      .select('role')
    expect(data ?? []).toHaveLength(0)
  })

  it('A nao consegue remover o membership de B', async () => {
    await alice.db.from('clinic_members').delete().eq('clinic_id', bob.clinicId)
    const { data: check } = await bob.db.from('clinic_members').select('user_id')
    expect(check).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
describe('5. Cliente anonimo nao acessa nada', () => {
  it('anon nao le pacientes, clinicas nem perfis', async () => {
    const anon = createAnonClient(env)
    for (const table of ['patients', 'clinics', 'clinic_members', 'profiles']) {
      const { data, error } = await anon.from(table).select('id')
      // Ou erro de permissao, ou conjunto vazio. O que nao pode e vir dado.
      expect(data ?? []).toHaveLength(0)
      if (error) expect(error.code).toBeDefined()
    }
  })

  it('anon nao consegue criar clinica pela RPC', async () => {
    const anon = createAnonClient(env)
    const { error } = await anon.rpc('create_clinic_with_owner', { p_name: 'Clinica Pirata' })
    expect(error).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
describe('6. Nivel API: JWT valido nao basta, o tenant e verificado', () => {
  it('A recebe 404 no paciente de B, identico a um id inexistente', async () => {
    if (!apiOnline) return
    const alheio = await apiGet(`/api/patients/${bob.patientId}`, alice.accessToken, alice.clinicId)
    const inexistente = await apiGet(
      `/api/patients/${UUID_INEXISTENTE}`,
      alice.accessToken,
      alice.clinicId,
    )

    expect(alheio.status).toBe(404)
    // Nao vazamos existencia: as duas respostas sao indistinguiveis.
    expect(alheio.status).toBe(inexistente.status)
    expect(alheio.body).toBe(inexistente.body)
    expect(alheio.body).not.toContain(bob.patientName)
  })

  it('HEADER FORJADO: A com X-Clinic-Id da Clinica B e barrado, sem vazar dado', async () => {
    if (!apiOnline) return
    const listagem = await apiGet('/api/patients', alice.accessToken, bob.clinicId)
    expect(listagem.status).toBe(403)
    expect(listagem.body).not.toContain(bob.patientName)
    expect(listagem.body).not.toContain(bob.patientId)

    const direto = await apiGet(`/api/patients/${bob.patientId}`, alice.accessToken, bob.clinicId)
    expect([403, 404]).toContain(direto.status)
    expect(direto.body).not.toContain(bob.patientName)
  })

  it('HEADER FORJADO: clinica inexistente e barrada do mesmo jeito', async () => {
    if (!apiOnline) return
    const resposta = await apiGet('/api/patients', alice.accessToken, UUID_INEXISTENTE)
    expect(resposta.status).toBe(403)
  })

  it('requisicao sem token e rejeitada', async () => {
    if (!apiOnline) return
    const resposta = await fetch(`${env.apiUrl}/api/patients`, {
      headers: { 'x-clinic-id': alice.clinicId },
    })
    expect(resposta.status).toBe(401)
  })

  it('A com o proprio X-Clinic-Id continua enxergando o proprio paciente', async () => {
    if (!apiOnline) return
    const resposta = await apiGet('/api/patients', alice.accessToken, alice.clinicId)
    expect(resposta.status).toBe(200)
    expect(resposta.body).toContain(alice.patientName)
    expect(resposta.body).not.toContain(bob.patientName)
  })
})
