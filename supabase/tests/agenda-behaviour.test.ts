/**
 * =============================================================================
 * COMPORTAMENTO DA AGENDA — filtro, histórico e reagendamento
 * =============================================================================
 *
 * Cobre os achados do teste manual que dependem de banco real:
 *   F. filtro por profissional com DOIS profissionais (o teste manual só tinha um)
 *   H. reagendamento não promove status sozinho
 *   I. histórico do paciente e "próxima consulta"
 *
 * Tudo em clínica sintética própria, limpa por ID no final. Nenhum dado real é
 * lido ou tocado.
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
let actor: TestActor
let profA: string
let profB: string
let patient2: string
let patient3: string
let apiOnline = false

/** Segunda-feira futura às 09:00 UTC. */
function monday(hour = 9, minute = 0): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7))
  d.setUTCHours(hour, minute, 0, 0)
  return d
}

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(`${env.apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${actor.accessToken}`,
      'x-clinic-id': actor.clinicId,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await r.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body }
}

/**
 * Envia e, se vier o 409 de avisos, reenvia confirmando o fingerprint exato.
 *
 * Espelha o que a secretaria faz na tela: vê o aviso e confirma o encaixe.
 * Sem isso, cada teste teria que escolher horários que por acaso caiam dentro
 * da disponibilidade — e passaria a falhar por motivo errado quando a fixture
 * mudasse. O que estes testes medem é filtro, status e histórico, não aviso.
 */
async function submit(path: string, method: 'POST' | 'PATCH', payload: Record<string, unknown>) {
  const first = await api(path, { method, body: JSON.stringify(payload) })
  if (first.status !== 409) return first

  const fingerprint = (first.body as { fingerprint?: string }).fingerprint
  if (!fingerprint) return first

  return api(path, {
    method,
    body: JSON.stringify({ ...payload, acknowledgedWarnings: fingerprint }),
  })
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)
  console.log(`test_run_id desta execucao: ${registry.testRunId}`)

  actor = await createActor(env, admin, registry, 'b')

  const { data: a } = await actor.db
    .from('professionals')
    .insert({ clinic_id: actor.clinicId, name: 'Dra. Alfa' })
    .select('id')
    .single<{ id: string }>()
  profA = a!.id

  const { data: b } = await actor.db
    .from('professionals')
    .insert({ clinic_id: actor.clinicId, name: 'Dr. Beta' })
    .select('id')
    .single<{ id: string }>()
  profB = b!.id

  const { data: p2 } = await actor.db
    .from('patients')
    .insert({ clinic_id: actor.clinicId, name: 'Paciente Dois', phone: '11955554444' })
    .select('id')
    .single<{ id: string }>()
  patient2 = p2!.id

  // Paciente EXCLUSIVO do bloco de historico: os testes de filtro tambem marcam
  // consultas para patient2, e a 'proxima consulta' dele passaria a ser a do
  // outro bloco — o teste falharia por contaminacao, nao por bug.
  const { data: p3 } = await actor.db
    .from('patients')
    .insert({ clinic_id: actor.clinicId, name: 'Paciente Historico', phone: '11933332222' })
    .select('id')
    .single<{ id: string }>()
  patient3 = p3!.id

  // Grades distintas: Alfa de manha, Beta a tarde.
  await actor.db.from('professional_availability').insert([
    {
      clinic_id: actor.clinicId,
      professional_id: profA,
      weekday: 1,
      start_time: '05:00:00',
      end_time: '10:00:00',
    },
    {
      clinic_id: actor.clinicId,
      professional_id: profB,
      weekday: 1,
      start_time: '14:00:00',
      end_time: '18:00:00',
    },
  ])

  try {
    apiOnline = (await fetch(`${env.apiUrl}/api/health`)).ok
  } catch {
    apiOnline = false
  }
  if (!apiOnline) throw new Error('API precisa estar no ar para estes testes.')
}, 180_000)

afterAll(async () => {
  if (admin && registry) await registry.cleanup(admin)
}, 120_000)

// ---------------------------------------------------------------------------
describe('F. Filtro por profissional com dois profissionais', () => {
  let apptA: string
  let apptB: string

  it('cria um agendamento para cada profissional', async () => {
    const base = monday()
    const rA = await api('/api/appointments', {
      method: 'POST',
      body: JSON.stringify({
        patientId: actor.patientId,
        professionalId: profA,
        startsAt: base.toISOString(),
        endsAt: new Date(base.getTime() + 1800_000).toISOString(),
      }),
    })
    expect(rA.status).toBe(201)
    apptA = (rA.body as { id: string }).id

    const tarde = monday(17)
    const rB = await api('/api/appointments', {
      method: 'POST',
      body: JSON.stringify({
        patientId: patient2,
        professionalId: profB,
        startsAt: tarde.toISOString(),
        endsAt: new Date(tarde.getTime() + 1800_000).toISOString(),
      }),
    })
    expect(rB.status).toBe(201)
    apptB = (rB.body as { id: string }).id
  })

  it('sem filtro ("Todos os profissionais") retorna os dois', async () => {
    const from = monday(0).toISOString()
    const to = new Date(monday(0).getTime() + 86400_000).toISOString()
    const r = await api(`/api/appointments?from=${from}&to=${to}`)
    const ids = (r.body as Array<{ id: string }>).map((a) => a.id)
    expect(ids).toContain(apptA)
    expect(ids).toContain(apptB)
  })

  it('filtrando por Alfa retorna somente o de Alfa', async () => {
    const from = monday(0).toISOString()
    const to = new Date(monday(0).getTime() + 86400_000).toISOString()
    const r = await api(`/api/appointments?from=${from}&to=${to}&professionalId=${profA}`)
    const rows = r.body as Array<{ id: string; professionalId: string }>
    expect(rows.map((a) => a.id)).toContain(apptA)
    expect(rows.map((a) => a.id)).not.toContain(apptB)
    expect(rows.every((a) => a.professionalId === profA)).toBe(true)
  })

  it('filtrando por Beta retorna somente o de Beta', async () => {
    const from = monday(0).toISOString()
    const to = new Date(monday(0).getTime() + 86400_000).toISOString()
    const r = await api(`/api/appointments?from=${from}&to=${to}&professionalId=${profB}`)
    const rows = r.body as Array<{ id: string; professionalId: string }>
    expect(rows.map((a) => a.id)).toContain(apptB)
    expect(rows.map((a) => a.id)).not.toContain(apptA)
  })

  it('a disponibilidade de cada profissional é a dele, não a do outro', async () => {
    const ra = await api(`/api/professionals/${profA}/availability`)
    const rb = await api(`/api/professionals/${profB}/availability`)
    const a = ra.body as Array<{ startTime: string; professionalId: string }>
    const b = rb.body as Array<{ startTime: string; professionalId: string }>

    expect(a.every((x) => x.professionalId === profA)).toBe(true)
    expect(b.every((x) => x.professionalId === profB)).toBe(true)
    expect(a[0]!.startTime).toBe('05:00:00')
    expect(b[0]!.startTime).toBe('14:00:00')
  })

  it('a rota da clínica devolve os blocos dos dois profissionais', async () => {
    // Alimenta a marca "fora do horario" sem filtro ativo.
    const r = await api('/api/professionals/availability')
    expect(r.status).toBe(200)
    const ids = new Set((r.body as Array<{ professionalId: string }>).map((x) => x.professionalId))
    expect(ids.has(profA)).toBe(true)
    expect(ids.has(profB)).toBe(true)
  })

  it('filtrar por profissional de outra clínica não vaza nada', async () => {
    const r = await api(`/api/appointments?professionalId=00000000-0000-4000-8000-000000000000`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('H. Reagendamento não promove status sozinho', () => {
  let appt: string

  it('prepara um agendamento confirmado', async () => {
    const base = monday(8)
    const r = await submit('/api/appointments', 'POST', {
      patientId: actor.patientId,
      professionalId: profA,
      startsAt: base.toISOString(),
      endsAt: new Date(base.getTime() + 1800_000).toISOString(),
    })
    expect(r.status).toBe(201)
    appt = (r.body as { id: string }).id

    await api(`/api/appointments/${appt}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'awaiting_confirmation' }),
    })
    const c = await api(`/api/appointments/${appt}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'confirmed' }),
    })
    expect((c.body as { status: string }).status).toBe('confirmed')
  })

  it('confirmed -> reschedule_requested', async () => {
    const r = await api(`/api/appointments/${appt}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'reschedule_requested' }),
    })
    expect((r.body as { status: string }).status).toBe('reschedule_requested')
  })

  it('ALTERAR O HORÁRIO mantém reschedule_requested — nada é automático', async () => {
    const novo = monday(9, 30)
    const r = await submit(`/api/appointments/${appt}`, 'PATCH', {
      startsAt: novo.toISOString(),
      endsAt: new Date(novo.getTime() + 1800_000).toISOString(),
    })
    expect(r.status).toBe(200)
    // O ponto do teste: o status NAO avancou sozinho.
    expect((r.body as { status: string }).status).toBe('reschedule_requested')
  })

  it('a pessoa escolhe explicitamente a saída', async () => {
    const r = await api(`/api/appointments/${appt}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'awaiting_confirmation' }),
    })
    expect((r.body as { status: string }).status).toBe('awaiting_confirmation')
  })
})

// ---------------------------------------------------------------------------
describe('I. Histórico do paciente e próxima consulta', () => {
  const futuro = new Date(Date.now() + 20 * 86400_000)
  const passado = new Date(Date.now() - 20 * 86400_000)
  let idCancelado: string
  let idRealizado: string
  let idFuturo: string

  it('monta o cenário: cancelado, realizado e um futuro', async () => {
    const mk = async (start: Date) => {
      const r = await submit('/api/appointments', 'POST', {
        patientId: patient3,
        professionalId: profB,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 1800_000).toISOString(),
      })
      expect(r.status).toBe(201)
      return (r.body as { id: string }).id
    }

    idCancelado = await mk(new Date(passado.getTime() + 3600_000))
    idRealizado = await mk(new Date(passado.getTime() + 7200_000))
    idFuturo = await mk(futuro)

    await api(`/api/appointments/${idCancelado}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    })
    await api(`/api/appointments/${idRealizado}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    })
  })

  it('cancelado e realizado PERMANECEM no histórico', async () => {
    const r = await api(`/api/appointments?patientId=${patient3}`)
    const ids = (r.body as Array<{ id: string }>).map((a) => a.id)
    expect(ids).toContain(idCancelado)
    expect(ids).toContain(idRealizado)
  })

  it('nem cancelado nem realizado viram "próxima consulta"', async () => {
    const r = await api(`/api/appointments?patientId=${patient3}`)
    const rows = r.body as Array<{ id: string; status: string; startsAt: string }>
    const agora = new Date()
    // Mesma regra da tela: futuro e nao cancelado.
    const proxima = rows
      .filter((a) => a.status !== 'cancelled' && new Date(a.startsAt) >= agora)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]

    expect(proxima?.id).toBe(idFuturo)
    expect(proxima?.id).not.toBe(idCancelado)
    expect(proxima?.id).not.toBe(idRealizado)
  })

  it('horário remarcado aparece com o horário final, não o original', async () => {
    const remarcado = new Date(futuro.getTime() + 3 * 3600_000)
    const r = await submit(`/api/appointments/${idFuturo}`, 'PATCH', {
      startsAt: remarcado.toISOString(),
      endsAt: new Date(remarcado.getTime() + 1800_000).toISOString(),
    })
    expect(r.status).toBe(200)

    const lista = await api(`/api/appointments?patientId=${patient3}`)
    const encontrado = (lista.body as Array<{ id: string; startsAt: string }>).find(
      (a) => a.id === idFuturo,
    )
    expect(new Date(encontrado!.startsAt).toISOString()).toBe(remarcado.toISOString())
  })

  it('o histórico do paciente 2 não traz agendamentos do paciente 1', async () => {
    const r = await api(`/api/appointments?patientId=${patient3}`)
    const rows = r.body as Array<{ patientId: string }>
    expect(rows.every((a) => a.patientId === patient3)).toBe(true)
  })
})
