/**
 * =============================================================================
 * AVISOS DE AGENDAMENTO — conflito, disponibilidade e confirmação consciente
 * =============================================================================
 *
 * Encaixe é deliberado na clínica, então nada aqui bloqueia. O que se testa é
 * que o aviso existe, que ele chega ao cliente, e que a confirmação vale para
 * um conjunto ESPECÍFICO de avisos — nunca um "sim" genérico que autorize às
 * cegas um conflito que surgiu depois.
 *
 * Tudo pela API, com o JWT real: é o caminho que o navegador percorre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createActor,
  createAdminClient,
  loadIsolationEnv,
  TestResourceRegistry,
  type IsolationEnv,
  type TestActor,
} from './helpers'

let env: IsolationEnv
let admin: SupabaseClient
let registry: TestResourceRegistry
let alice: TestActor
let professionalId: string
let serviceId: string
let apiOnline = false

/** Segunda-feira às 09:00 UTC — dentro da disponibilidade criada abaixo. */
let mondayNine: Date

interface ApiResult {
  status: number
  body: Record<string, unknown>
}

async function api(path: string, init: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${env.apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${alice.accessToken}`,
      'x-clinic-id': alice.clinicId,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: Record<string, unknown>
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body }
}

function createAppointment(payload: Record<string, unknown>): Promise<ApiResult> {
  return api('/api/appointments', { method: 'POST', body: JSON.stringify(payload) })
}

function isoAt(base: Date, offsetMinutes: number): string {
  return new Date(base.getTime() + offsetMinutes * 60_000).toISOString()
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)
  console.log(`test_run_id desta execucao: ${registry.testRunId}`)

  alice = await createActor(env, admin, registry, 'w')

  mondayNine = new Date()
  mondayNine.setUTCDate(mondayNine.getUTCDate() + ((8 - mondayNine.getUTCDay()) % 7 || 7))
  mondayNine.setUTCHours(9, 0, 0, 0)

  const { data: professional } = await alice.db
    .from('professionals')
    .insert({ clinic_id: alice.clinicId, name: 'Dra. Avisos' })
    .select('id')
    .single<{ id: string }>()
  professionalId = professional!.id

  const { data: service } = await alice.db
    .from('services')
    .insert({ clinic_id: alice.clinicId, name: 'Consulta', duration_minutes: 30 })
    .select('id')
    .single<{ id: string }>()
  serviceId = service!.id

  // A clinica usa America/Sao_Paulo (UTC-3), entao 09:00Z = 06:00 local, que cai
  // FORA da faixa 08:00-12:00. Declaramos 05:00-10:00 local para que 09:00Z
  // (06:00 local) fique DENTRO, isolando o teste de conflito do de disponibilidade.
  await alice.db.from('professional_availability').insert({
    clinic_id: alice.clinicId,
    professional_id: professionalId,
    weekday: 1,
    start_time: '05:00:00',
    end_time: '10:00:00',
  })

  try {
    const health = await fetch(`${env.apiUrl}/api/health`)
    apiOnline = health.ok
  } catch {
    apiOnline = false
  }
  if (!apiOnline) throw new Error('API precisa estar no ar para os testes de avisos.')
}, 180_000)

afterAll(async () => {
  if (admin && registry) await registry.cleanup(admin)
}, 120_000)

describe('1. Horario limpo nao gera aviso', () => {
  it('agendamento dentro da disponibilidade e sem conflito e criado direto', async () => {
    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      serviceId,
      startsAt: isoAt(mondayNine, 0),
      endsAt: isoAt(mondayNine, 30),
    })
    expect(result.status).toBe(201)
  })
})

describe('2. Conflito de horario avisa, nao bloqueia', () => {
  it('sobreposicao devolve 409 com o conflitante e um fingerprint', async () => {
    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 15),
      endsAt: isoAt(mondayNine, 45),
    })

    expect(result.status).toBe(409)
    expect(result.body.error).toBe('APPOINTMENT_WARNINGS')
    expect(result.body.fingerprint).toMatch(/^[0-9a-f]{64}$/)

    const warnings = result.body.warnings as Array<{ type: string; appointments?: unknown[] }>
    const overlap = warnings.find((w) => w.type === 'overlap')
    expect(overlap).toBeDefined()
    expect(overlap!.appointments!.length).toBeGreaterThanOrEqual(1)
  })

  it('reenviar com o fingerprint correto cria o encaixe', async () => {
    const first = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 15),
      endsAt: isoAt(mondayNine, 45),
    })
    expect(first.status).toBe(409)

    const confirmed = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 15),
      endsAt: isoAt(mondayNine, 45),
      acknowledgedWarnings: first.body.fingerprint,
    })
    // Encaixe deliberado e permitido.
    expect(confirmed.status).toBe(201)
  })

  it('agendamento cancelado nao conta como conflito', async () => {
    const created = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 120),
      endsAt: isoAt(mondayNine, 150),
    })
    expect(created.status).toBe(201)

    await api(`/api/appointments/${created.body.id as string}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    })

    // Mesmo horario do cancelado: o slot esta livre de fato.
    const reused = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 120),
      endsAt: isoAt(mondayNine, 150),
    })
    expect(reused.status).toBe(201)
  })
})

describe('3. Fora da disponibilidade avisa, nao bloqueia', () => {
  it('horario fora da faixa devolve 409 com a janela declarada', async () => {
    // 23:00Z = 20:00 local, muito depois de 10:00 local.
    const late = new Date(mondayNine)
    late.setUTCHours(23, 0, 0, 0)

    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: late.toISOString(),
      endsAt: new Date(late.getTime() + 30 * 60_000).toISOString(),
    })

    expect(result.status).toBe(409)
    const warnings = result.body.warnings as Array<{
      type: string
      availability?: Array<{ startTime: string; endTime: string }>
    }>
    const outside = warnings.find((w) => w.type === 'outside_availability')
    expect(outside).toBeDefined()
    expect(outside!.availability).toBeDefined()
  })

  it('confirmando o aviso, o agendamento fora da faixa e criado', async () => {
    const late = new Date(mondayNine)
    late.setUTCHours(23, 30, 0, 0)
    const payload = {
      patientId: alice.patientId,
      professionalId,
      startsAt: late.toISOString(),
      endsAt: new Date(late.getTime() + 30 * 60_000).toISOString(),
    }

    const first = await createAppointment(payload)
    expect(first.status).toBe(409)

    const confirmed = await createAppointment({
      ...payload,
      acknowledgedWarnings: first.body.fingerprint,
    })
    expect(confirmed.status).toBe(201)
  })

  it('dia sem nenhuma faixa avisa com availability vazia', async () => {
    // Terca-feira: nao ha bloco cadastrado.
    const tuesday = new Date(mondayNine)
    tuesday.setUTCDate(tuesday.getUTCDate() + 1)

    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: tuesday.toISOString(),
      endsAt: new Date(tuesday.getTime() + 30 * 60_000).toISOString(),
    })

    expect(result.status).toBe(409)
    const warnings = result.body.warnings as Array<{
      type: string
      availability?: unknown[]
    }>
    const outside = warnings.find((w) => w.type === 'outside_availability')
    expect(outside!.availability).toEqual([])
  })
})

describe('4. Fingerprint desatualizado nao autoriza as cegas', () => {
  it('fingerprint de outro conjunto de avisos e recusado com 409 novo', async () => {
    const slot = 300 // minutos apos mondayNine, longe dos demais testes

    // Primeiro aviso: so "fora da disponibilidade".
    const first = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, slot),
      endsAt: isoAt(mondayNine, slot + 30),
    })
    expect(first.status).toBe(409)
    const staleFingerprint = first.body.fingerprint as string

    // A situacao MUDA: alguem marca no mesmo horario nesse meio-tempo.
    const intruder = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, slot),
      endsAt: isoAt(mondayNine, slot + 30),
      acknowledgedWarnings: staleFingerprint,
    })
    expect(intruder.status).toBe(201)

    // Agora ha conflito ALEM do aviso de disponibilidade. O fingerprint antigo
    // descreve um estado que nao existe mais e nao pode valer como confirmacao.
    const stale = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, slot),
      endsAt: isoAt(mondayNine, slot + 30),
      acknowledgedWarnings: staleFingerprint,
    })

    expect(stale.status).toBe(409)
    expect(stale.body.fingerprint).not.toBe(staleFingerprint)

    const warnings = stale.body.warnings as Array<{ type: string }>
    expect(warnings.map((w) => w.type).sort()).toEqual(['outside_availability', 'overlap'])

    // E o fingerprint NOVO funciona.
    const retried = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, slot),
      endsAt: isoAt(mondayNine, slot + 30),
      acknowledgedWarnings: stale.body.fingerprint,
    })
    expect(retried.status).toBe(201)
  })

  it('fingerprint inventado e recusado', async () => {
    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 15),
      endsAt: isoAt(mondayNine, 45),
      acknowledgedWarnings: 'f'.repeat(64),
    })
    expect(result.status).toBe(409)
  })

  it('boolean generico nao e aceito como confirmacao', async () => {
    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 15),
      endsAt: isoAt(mondayNine, 45),
      acknowledgedWarnings: true,
    })
    // Rejeitado na validacao do schema, antes de qualquer logica de aviso.
    expect(result.status).toBe(400)
  })
})

describe('5. Inativos saem do fluxo de marcacao, historico permanece', () => {
  it('profissional inativo e recusado em agendamento novo', async () => {
    const { data: professional } = await alice.db
      .from('professionals')
      .insert({ clinic_id: alice.clinicId, name: 'Dr. Afastado', active: false })
      .select('id')
      .single<{ id: string }>()

    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId: professional!.id,
      startsAt: isoAt(mondayNine, 400),
      endsAt: isoAt(mondayNine, 430),
    })
    expect(result.status).toBe(409)
    expect(String(result.body.message)).toContain('inativo')
  })

  it('servico inativo e recusado em agendamento novo', async () => {
    const { data: service } = await alice.db
      .from('services')
      .insert({
        clinic_id: alice.clinicId,
        name: 'Servico Descontinuado',
        duration_minutes: 30,
        active: false,
      })
      .select('id')
      .single<{ id: string }>()

    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      serviceId: service!.id,
      startsAt: isoAt(mondayNine, 440),
      endsAt: isoAt(mondayNine, 470),
    })
    expect(result.status).toBe(409)
    expect(String(result.body.message)).toContain('inativo')
  })

  it('agendamento historico sobrevive a desativacao do servico e ainda pode ser editado', async () => {
    const { data: service } = await alice.db
      .from('services')
      .insert({ clinic_id: alice.clinicId, name: 'Servico Temporario', duration_minutes: 30 })
      .select('id')
      .single<{ id: string }>()

    const created = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      serviceId: service!.id,
      startsAt: isoAt(mondayNine, 480),
      endsAt: isoAt(mondayNine, 510),
      acknowledgedWarnings: undefined,
    })
    const appointmentId =
      created.status === 201
        ? (created.body.id as string)
        : ((
            await createAppointment({
              patientId: alice.patientId,
              professionalId,
              serviceId: service!.id,
              startsAt: isoAt(mondayNine, 480),
              endsAt: isoAt(mondayNine, 510),
              acknowledgedWarnings: created.body.fingerprint,
            })
          ).body.id as string)

    // Servico sai de linha DEPOIS do agendamento existir.
    await alice.db.from('services').update({ active: false }).eq('id', service!.id)

    // A referencia historica continua la...
    const fetched = await api(`/api/appointments/${appointmentId}`)
    expect(fetched.status).toBe(200)
    expect(fetched.body.serviceId).toBe(service!.id)

    // ...e editar outro campo nao revalida o servico inativo.
    const edited = await api(`/api/appointments/${appointmentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'Paciente avisado da mudanca' }),
    })
    expect(edited.status).toBe(200)
  })
})

describe('6. Agendamento sem servico exige duracao valida', () => {
  it('sem servico, criar com fim depois do inicio funciona', async () => {
    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 600),
      endsAt: isoAt(mondayNine, 645),
    })
    expect([201, 409]).toContain(result.status)
  })

  it('fim igual ao inicio e recusado', async () => {
    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 700),
      endsAt: isoAt(mondayNine, 700),
    })
    expect(result.status).toBe(400)
  })

  it('fim antes do inicio e recusado', async () => {
    const result = await createAppointment({
      patientId: alice.patientId,
      professionalId,
      startsAt: isoAt(mondayNine, 700),
      endsAt: isoAt(mondayNine, 690),
    })
    expect(result.status).toBe(400)
  })

  it('o banco recusa ends_at <= starts_at mesmo por caminho privilegiado', async () => {
    // A validacao da API pode ser contornada; o CHECK constraint nao.
    const { error } = await admin.from('appointments').insert({
      clinic_id: alice.clinicId,
      patient_id: alice.patientId,
      professional_id: professionalId,
      starts_at: isoAt(mondayNine, 800),
      ends_at: isoAt(mondayNine, 800),
    })
    expect(error).not.toBeNull()
    // 23514 = check_violation
    expect(error!.code).toBe('23514')
  })
})
