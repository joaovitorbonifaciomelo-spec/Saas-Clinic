/**
 * =============================================================================
 * ISOLAMENTO ENTRE CLÍNICAS — MÓDULO AGENDA
 * =============================================================================
 *
 * Estende o cenário A/B da fundação para profissionais, serviços,
 * disponibilidade e agendamentos.
 *
 * Duas camadas distintas são exercitadas aqui, e a diferença importa:
 *
 *   1. RLS — o que cada usuário enxerga e consegue escrever. Testado com o JWT
 *      real de cada um.
 *   2. FKs COMPOSTAS tenant-first — a garantia de que um agendamento nunca
 *      referencia paciente/profissional/serviço de outra clínica. Testado
 *      TAMBÉM com service_role, que ignora RLS: se a barreira fosse só de
 *      policy, o caminho privilegiado passaria. O ponto é provar que não passa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createActor,
  createAdminClient,
  createAgendaFixture,
  createAnonClient,
  loadIsolationEnv,
  TestResourceRegistry,
  type AgendaFixture,
  type IsolationEnv,
  type TestActor,
} from './helpers'

const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000'

let env: IsolationEnv
let admin: SupabaseClient
let registry: TestResourceRegistry
let alice: TestActor
let bob: TestActor
let agendaA: AgendaFixture
let agendaB: AgendaFixture
let apiOnline = false

async function apiRequest(
  path: string,
  token: string,
  clinicId: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${env.apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-clinic-id': clinicId,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  return { status: response.status, body: await response.text() }
}

/** Próxima segunda-feira às 09:00 UTC — dentro da disponibilidade do fixture. */
function nextMonday(): Date {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7 || 7))
  date.setUTCHours(9, 0, 0, 0)
  return date
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)
  console.log(`test_run_id desta execucao: ${registry.testRunId}`)

  alice = await createActor(env, admin, registry, 'a')
  bob = await createActor(env, admin, registry, 'b')

  const monday = nextMonday()
  agendaA = await createAgendaFixture(alice, monday)
  agendaB = await createAgendaFixture(bob, monday)

  try {
    const health = await fetch(`${env.apiUrl}/api/health`)
    apiOnline = health.ok
  } catch {
    apiOnline = false
  }
}, 180_000)

afterAll(async () => {
  if (admin && registry) await registry.cleanup(admin)
}, 120_000)

// ---------------------------------------------------------------------------
describe('1. Leitura das entidades da agenda e restrita a propria clinica', () => {
  it('A lista apenas o proprio profissional', async () => {
    const { data } = await alice.db.from('professionals').select('id')
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(agendaA.professionalId)
  })

  it('A pedindo o profissional de B recebe vazio', async () => {
    const { data } = await alice.db
      .from('professionals')
      .select('id')
      .eq('id', agendaB.professionalId)
    expect(data).toHaveLength(0)
  })

  it('A lista apenas o proprio servico', async () => {
    const { data } = await alice.db.from('services').select('id')
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(agendaA.serviceId)
  })

  it('A pedindo o servico de B recebe vazio', async () => {
    const { data } = await alice.db.from('services').select('id').eq('id', agendaB.serviceId)
    expect(data).toHaveLength(0)
  })

  it('A ve apenas a propria disponibilidade', async () => {
    const { data } = await alice.db.from('professional_availability').select('professional_id')
    expect(data).toHaveLength(1)
    expect(data![0]!.professional_id).toBe(agendaA.professionalId)
  })

  it('A pedindo a disponibilidade do profissional de B recebe vazio', async () => {
    const { data } = await alice.db
      .from('professional_availability')
      .select('id')
      .eq('professional_id', agendaB.professionalId)
    expect(data).toHaveLength(0)
  })

  it('A lista apenas o proprio agendamento', async () => {
    const { data } = await alice.db.from('appointments').select('id')
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(agendaA.appointmentId)
  })

  it('A pedindo o agendamento de B recebe vazio', async () => {
    const { data } = await alice.db
      .from('appointments')
      .select('id')
      .eq('id', agendaB.appointmentId)
    expect(data).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe('2. Referencia cruzada e impossivel — garantia estrutural', () => {
  it('A nao cria agendamento com o paciente de B', async () => {
    const { error } = await alice.db.from('appointments').insert({
      clinic_id: alice.clinicId,
      patient_id: bob.patientId,
      professional_id: agendaA.professionalId,
      starts_at: agendaA.appointmentStartsAt,
      ends_at: agendaA.appointmentEndsAt,
    })
    expect(error).not.toBeNull()
  })

  it('A nao cria agendamento com o profissional de B', async () => {
    const { error } = await alice.db.from('appointments').insert({
      clinic_id: alice.clinicId,
      patient_id: alice.patientId,
      professional_id: agendaB.professionalId,
      starts_at: agendaA.appointmentStartsAt,
      ends_at: agendaA.appointmentEndsAt,
    })
    expect(error).not.toBeNull()
  })

  it('A nao cria agendamento com o servico de B', async () => {
    const { error } = await alice.db.from('appointments').insert({
      clinic_id: alice.clinicId,
      patient_id: alice.patientId,
      professional_id: agendaA.professionalId,
      service_id: agendaB.serviceId,
      starts_at: agendaA.appointmentStartsAt,
      ends_at: agendaA.appointmentEndsAt,
    })
    expect(error).not.toBeNull()
  })

  /**
   * O teste decisivo. service_role ignora RLS por design — se a proteção
   * cross-tenant morasse nas policies, este insert passaria. A FK composta
   * tenant-first não é uma policy: é integridade referencial, e vale para
   * qualquer chamador.
   */
  it('NEM MESMO service_role cria referencia cross-tenant', async () => {
    const cases = [
      {
        label: 'paciente de outra clinica',
        row: { patient_id: bob.patientId, professional_id: agendaA.professionalId },
      },
      {
        label: 'profissional de outra clinica',
        row: { patient_id: alice.patientId, professional_id: agendaB.professionalId },
      },
      {
        label: 'servico de outra clinica',
        row: {
          patient_id: alice.patientId,
          professional_id: agendaA.professionalId,
          service_id: agendaB.serviceId,
        },
      },
    ]

    for (const testCase of cases) {
      const { error } = await admin.from('appointments').insert({
        clinic_id: alice.clinicId,
        starts_at: agendaA.appointmentStartsAt,
        ends_at: agendaA.appointmentEndsAt,
        ...testCase.row,
      })
      // 23503 = foreign_key_violation
      expect(error, `service_role conseguiu inserir ${testCase.label}`).not.toBeNull()
      expect(error!.code).toBe('23503')
    }
  })

  it('service_role tambem nao vincula disponibilidade a profissional de outra clinica', async () => {
    const { error } = await admin.from('professional_availability').insert({
      clinic_id: alice.clinicId,
      professional_id: agendaB.professionalId,
      weekday: 2,
      start_time: '08:00:00',
      end_time: '12:00:00',
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23503')
  })
})

// ---------------------------------------------------------------------------
describe('3. Escrita cruzada nas entidades da agenda e negada', () => {
  it('A nao edita o profissional de B', async () => {
    const { data } = await alice.db
      .from('professionals')
      .update({ name: 'INVADIDO' })
      .eq('id', agendaB.professionalId)
      .select('id')
    expect(data ?? []).toHaveLength(0)
  })

  it('A nao desativa o servico de B', async () => {
    const { data } = await alice.db
      .from('services')
      .update({ active: false })
      .eq('id', agendaB.serviceId)
      .select('id')
    expect(data ?? []).toHaveLength(0)
  })

  it('A nao remove a disponibilidade de B', async () => {
    await alice.db
      .from('professional_availability')
      .delete()
      .eq('professional_id', agendaB.professionalId)
    const { data } = await bob.db.from('professional_availability').select('id')
    expect(data).toHaveLength(1)
  })

  it('A nao edita o agendamento de B', async () => {
    const { data } = await alice.db
      .from('appointments')
      .update({ notes: 'INVADIDO' })
      .eq('id', agendaB.appointmentId)
      .select('id')
    expect(data ?? []).toHaveLength(0)
  })

  it('A nao reagenda o agendamento de B', async () => {
    const novo = new Date(Date.parse(agendaB.appointmentStartsAt) + 3600_000).toISOString()
    const { data } = await alice.db
      .from('appointments')
      .update({ starts_at: novo })
      .eq('id', agendaB.appointmentId)
      .select('id')
    expect(data ?? []).toHaveLength(0)

    const { data: check } = await bob.db
      .from('appointments')
      .select('starts_at')
      .eq('id', agendaB.appointmentId)
    expect(check![0]!.starts_at).not.toBe(novo)
  })

  it('A nao cancela nem altera o status do agendamento de B', async () => {
    const { data } = await alice.db
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', agendaB.appointmentId)
      .select('id')
    expect(data ?? []).toHaveLength(0)

    const { data: check } = await bob.db
      .from('appointments')
      .select('status')
      .eq('id', agendaB.appointmentId)
    expect(check![0]!.status).toBe('scheduled')
  })

  it('A nao move o proprio agendamento para a clinica B', async () => {
    const { error } = await alice.db
      .from('appointments')
      .update({ clinic_id: bob.clinicId })
      .eq('id', agendaA.appointmentId)
    expect(error).not.toBeNull()
  })

  it('appointments nao aceita DELETE — cancelamento e via status', async () => {
    await alice.db.from('appointments').delete().eq('id', agendaA.appointmentId)
    const { data } = await alice.db.from('appointments').select('id')
    expect(data).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
describe('4. Transicoes de status sao aplicadas pelo banco', () => {
  it('scheduled pode ir direto para completed — o paciente comparece sem confirmar', async () => {
    const { data: created } = await alice.db
      .from('appointments')
      .insert({
        clinic_id: alice.clinicId,
        patient_id: alice.patientId,
        professional_id: agendaA.professionalId,
        starts_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 10800_000).toISOString(),
        ends_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 12600_000).toISOString(),
      })
      .select('id')
      .single<{ id: string }>()

    const { error } = await alice.db
      .from('appointments')
      .update({ status: 'completed' })
      .eq('id', created!.id)
    expect(error).toBeNull()
  })

  it('confirmed nao volta para awaiting_confirmation', async () => {
    const { data: created } = await alice.db
      .from('appointments')
      .insert({
        clinic_id: alice.clinicId,
        patient_id: alice.patientId,
        professional_id: agendaA.professionalId,
        starts_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 14400_000).toISOString(),
        ends_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 16200_000).toISOString(),
      })
      .select('id')
      .single<{ id: string }>()

    await alice.db.from('appointments').update({ status: 'confirmed' }).eq('id', created!.id)

    const { error } = await alice.db
      .from('appointments')
      .update({ status: 'awaiting_confirmation' })
      .eq('id', created!.id)
    expect(error).not.toBeNull()
  })

  it('UPDATE que nao muda o status nao e tratado como transicao', async () => {
    // Reagendar um cancelado envia `status` inalterado junto do patch. O trigger
    // dispara, mas status igual nao e transicao — nao pode virar erro.
    const { data: created } = await alice.db
      .from('appointments')
      .insert({
        clinic_id: alice.clinicId,
        patient_id: alice.patientId,
        professional_id: agendaA.professionalId,
        starts_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 18000_000).toISOString(),
        ends_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 19800_000).toISOString(),
      })
      .select('id')
      .single<{ id: string }>()

    await alice.db.from('appointments').update({ status: 'cancelled' }).eq('id', created!.id)

    // Estado terminal, mas o status enviado e o mesmo que ja esta la.
    const { error } = await alice.db
      .from('appointments')
      .update({ status: 'cancelled', notes: 'remarcar depois' })
      .eq('id', created!.id)
    expect(error).toBeNull()
  })

  it('cancelled e terminal', async () => {
    const { data: created } = await alice.db
      .from('appointments')
      .insert({
        clinic_id: alice.clinicId,
        patient_id: alice.patientId,
        professional_id: agendaA.professionalId,
        starts_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 7200_000).toISOString(),
        ends_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 9000_000).toISOString(),
      })
      .select('id')
      .single<{ id: string }>()

    await alice.db.from('appointments').update({ status: 'cancelled' }).eq('id', created!.id)

    const { error } = await alice.db
      .from('appointments')
      .update({ status: 'scheduled' })
      .eq('id', created!.id)
    expect(error).not.toBeNull()
  })

  it('reschedule_requested pode ser cancelado sem passar por nova data', async () => {
    const { data: created } = await alice.db
      .from('appointments')
      .insert({
        clinic_id: alice.clinicId,
        patient_id: alice.patientId,
        professional_id: agendaA.professionalId,
        starts_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 21600_000).toISOString(),
        ends_at: new Date(Date.parse(agendaA.appointmentStartsAt) + 23400_000).toISOString(),
      })
      .select('id')
      .single<{ id: string }>()

    await alice.db
      .from('appointments')
      .update({ status: 'reschedule_requested' })
      .eq('id', created!.id)

    const { error } = await alice.db
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', created!.id)
    expect(error).toBeNull()
  })

  it('o caminho scheduled -> awaiting_confirmation -> confirmed funciona', async () => {
    const first = await alice.db
      .from('appointments')
      .update({ status: 'awaiting_confirmation' })
      .eq('id', agendaA.appointmentId)
      .select('status')
      .maybeSingle()
    expect(first.error).toBeNull()

    const second = await alice.db
      .from('appointments')
      .update({ status: 'confirmed' })
      .eq('id', agendaA.appointmentId)
      .select('status')
      .maybeSingle()
    expect(second.error).toBeNull()
    expect((second.data as { status: string }).status).toBe('confirmed')
  })
})

// ---------------------------------------------------------------------------
describe('5. Cliente anonimo nao acessa a agenda', () => {
  it('anon nao le nenhuma das quatro tabelas novas', async () => {
    const anon = createAnonClient(env)
    for (const table of [
      'professionals',
      'services',
      'professional_availability',
      'appointments',
    ]) {
      const { data } = await anon.from(table).select('id')
      expect(data ?? []).toHaveLength(0)
    }
  })
})

// ---------------------------------------------------------------------------
describe('6. Nivel API: tenant verificado nas rotas da agenda', () => {
  it('HEADER FORJADO: JWT de A + X-Clinic-Id de B e barrado nas quatro rotas', async () => {
    if (!apiOnline) return
    for (const path of [
      '/api/professionals',
      '/api/services',
      '/api/appointments',
      `/api/professionals/${agendaB.professionalId}/availability`,
    ]) {
      const response = await apiRequest(path, alice.accessToken, bob.clinicId)
      expect(response.status, `${path} deveria ser 403`).toBe(403)
      expect(response.body).not.toContain(agendaB.professionalId)
      expect(response.body).not.toContain(agendaB.appointmentId)
    }
  })

  it('A recebe 404 no agendamento de B, identico a um id inexistente', async () => {
    if (!apiOnline) return
    const alheio = await apiRequest(
      `/api/appointments/${agendaB.appointmentId}`,
      alice.accessToken,
      alice.clinicId,
    )
    const inexistente = await apiRequest(
      `/api/appointments/${UUID_INEXISTENTE}`,
      alice.accessToken,
      alice.clinicId,
    )
    expect(alheio.status).toBe(404)
    expect(alheio.body).toBe(inexistente.body)
  })

  it('A recebe 404 no profissional e no servico de B', async () => {
    if (!apiOnline) return
    for (const path of [
      `/api/professionals/${agendaB.professionalId}`,
      `/api/services/${agendaB.serviceId}`,
    ]) {
      const response = await apiRequest(path, alice.accessToken, alice.clinicId)
      expect(response.status, path).toBe(404)
    }
  })

  it('A nao altera o status do agendamento de B pela API', async () => {
    if (!apiOnline) return
    const response = await apiRequest(
      `/api/appointments/${agendaB.appointmentId}/status`,
      alice.accessToken,
      alice.clinicId,
      { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) },
    )
    expect(response.status).toBe(404)

    const { data } = await bob.db
      .from('appointments')
      .select('status')
      .eq('id', agendaB.appointmentId)
    expect(data![0]!.status).not.toBe('cancelled')
  })

  it('A nao cria agendamento com paciente de B pela API', async () => {
    if (!apiOnline) return
    const response = await apiRequest('/api/appointments', alice.accessToken, alice.clinicId, {
      method: 'POST',
      body: JSON.stringify({
        patientId: bob.patientId,
        professionalId: agendaA.professionalId,
        startsAt: agendaA.appointmentStartsAt,
        endsAt: agendaA.appointmentEndsAt,
      }),
    })
    expect([400, 404, 409, 500]).toContain(response.status)
    expect(response.status).not.toBe(201)
  })

  it('requisicao sem token e rejeitada nas rotas da agenda', async () => {
    if (!apiOnline) return
    const response = await fetch(`${env.apiUrl}/api/appointments`, {
      headers: { 'x-clinic-id': alice.clinicId },
    })
    expect(response.status).toBe(401)
  })
})
