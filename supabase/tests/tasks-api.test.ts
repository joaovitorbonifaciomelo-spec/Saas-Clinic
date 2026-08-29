/**
 * API de leitura de Pendencias, contra a API e o Supabase reais.
 *
 * As tres rotas sao somente leitura. Toda escrita usada como fixture aqui passa
 * pelas RPCs controladas — que e o unico caminho que existe, porque
 * `authenticated` nao tem INSERT nem UPDATE nas tabelas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskDetail, TaskEventView, TaskListItem, Page } from '@clinicas/shared'
import { dayBoundsInTimezone } from '@clinicas/shared'
import {
  UUID_INEXISTENTE,
  assumir,
  cancelar,
  concluir,
  montarCenario,
  novaTask,
  type Cenario,
  type TaskRow,
} from './task-helpers'

let c: Cenario
let fuso: string

interface Resposta<T> {
  status: number
  body: string
  json: T
}

async function get<T>(
  path: string,
  token: string,
  clinicId: string | null,
): Promise<Resposta<T>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (clinicId) headers['x-clinic-id'] = clinicId
  const r = await fetch(`${c.env.apiUrl}/api${path}`, { headers })
  const body = await r.text()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    // Corpo que nao e JSON e resposta legitima de erro: quem chama decide.
    json = null
  }
  return { status: r.status, body, json: json as T }
}

const comoMaria = <T,>(path: string) =>
  get<T>(path, c.maria.accessToken, c.maria.clinicId)

const lista = async (qs: string) => {
  const r = await comoMaria<Page<TaskListItem>>(`/tasks${qs}`)
  expect(r.status, r.body.slice(0, 300)).toBe(200)
  return r.json
}

const ids = (p: Page<TaskListItem>) => p.items.map((i) => i.id)

beforeAll(async () => {
  c = await montarCenario()
  const { data } = await c.admin
    .from('clinics')
    .select('timezone')
    .eq('id', c.maria.clinicId)
    .single()
  fuso = (data as { timezone: string }).timezone

  const saude = await fetch(`${c.env.apiUrl}/api/health`).catch(() => null)
  if (!saude?.ok) throw new Error(`API precisa estar no ar em ${c.env.apiUrl}.`)
}, 120_000)

afterAll(async () => {
  await c?.registry.cleanup(c.admin)
}, 120_000)

/* =============================================================================
   Fixtures temporais
   ========================================================================== */

async function cenarioTemporal() {
  const { startOfToday, startOfTomorrow } = dayBoundsInTimezone(fuso, new Date())
  const atrasada = await novaTask(c.maria.db, c.maria.clinicId, {
    title: 'Venceu ontem',
    dueAt: new Date(startOfToday.getTime() - 1000).toISOString(),
  })
  const hojeCedo = await novaTask(c.maria.db, c.maria.clinicId, {
    title: 'Meia-noite local',
    dueAt: startOfToday.toISOString(),
  })
  // 21h em Sao Paulo ja e o dia seguinte em UTC: o caso que motivou R3.
  const hojeNoite = await novaTask(c.maria.db, c.maria.clinicId, {
    title: '21h local',
    dueAt: new Date(startOfTomorrow.getTime() - 3 * 3_600_000).toISOString(),
  })
  const proxima = await novaTask(c.maria.db, c.maria.clinicId, {
    title: 'Amanha cedo',
    dueAt: startOfTomorrow.toISOString(),
  })
  const semPrazo = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Assim que possivel' })
  return { atrasada, hojeCedo, hojeNoite, proxima, semPrazo }
}

describe('GET /api/tasks — recortes temporais', () => {
  let f: Awaited<ReturnType<typeof cenarioTemporal>>

  beforeAll(async () => {
    f = await cenarioTemporal()
  }, 120_000)

  it('default e status=open, due=any, assignment=any', async () => {
    const p = await lista('')
    const encontrados = ids(p)
    for (const t of Object.values(f)) expect(encontrados).toContain(t.id)
  })

  it('overdue traz so o que venceu ANTES do inicio de hoje local', async () => {
    const p = await lista('?due=overdue')
    expect(ids(p)).toContain(f.atrasada.id)
    expect(ids(p)).not.toContain(f.hojeCedo.id)
    expect(ids(p)).not.toContain(f.hojeNoite.id)
  })

  it('today inclui 21h local, que ja e amanha em UTC', async () => {
    const p = await lista('?due=today')
    expect(ids(p)).toContain(f.hojeCedo.id)
    // O caso de R3: cortar o dia em UTC jogaria esta em "proximas" e ela
    // sumiria da aba Hoje no fim do expediente.
    expect(ids(p)).toContain(f.hojeNoite.id)
    expect(ids(p)).not.toContain(f.proxima.id)
  })

  it('upcoming comeca na meia-noite local de amanha', async () => {
    const p = await lista('?due=upcoming')
    expect(ids(p)).toContain(f.proxima.id)
    expect(ids(p)).not.toContain(f.hojeNoite.id)
  })

  it('none traz so as sem prazo', async () => {
    const p = await lista('?due=none')
    expect(ids(p)).toContain(f.semPrazo.id)
    expect(p.items.every((i) => i.dueAt === null)).toBe(true)
  })

  it('os quatro recortes formam uma PARTICAO das abertas', async () => {
    const [todas, atrasadas, hoje, proximas, semPrazo] = await Promise.all([
      lista(''),
      lista('?due=overdue'),
      lista('?due=today'),
      lista('?due=upcoming'),
      lista('?due=none'),
    ])
    const conjuntos = [atrasadas, hoje, proximas, semPrazo].map((p) => new Set(ids(p)))
    for (const id of ids(todas)) {
      expect(conjuntos.filter((s) => s.has(id))).toHaveLength(1)
    }
  })

  it('isPastDue e outra coisa que a aba Atrasadas', async () => {
    const p = await lista('?due=today')
    const item = p.items.find((i) => i.id === f.hojeCedo.id)!
    // Prazo era meia-noite de hoje e ja passou: o item esta em HOJE e tambem
    // com isPastDue = true. Sao perguntas diferentes, de proposito.
    expect(item.isPastDue).toBe(true)
  })
})

describe('GET /api/tasks — filtros de responsavel e status', () => {
  it('mine sai do JWT, nao da URL', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Da Maria' })
    await assumir(c.maria.db, t)
    const p = await lista('?assignment=mine')
    expect(ids(p)).toContain(t.id)
    expect(p.items.every((i) => i.isMine)).toBe(true)
  })

  it('unassigned traz so a fila geral', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Sem dono' })
    const p = await lista('?assignment=unassigned')
    expect(ids(p)).toContain(t.id)
    expect(p.items.every((i) => i.assignedTo === null)).toBe(true)
  })

  it('assigneeId valido filtra e resolve o nome atual', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Do Joao' })
    await assumir(c.joao.db, t)
    const p = await lista(`?assigneeId=${c.joao.userId}`)
    const item = p.items.find((i) => i.id === t.id)!
    expect(item.assignee).toEqual({ userId: c.joao.userId, displayName: 'Colega JOAO' })
    expect(item.isMine).toBe(false)
  })

  it('assigneeId de outra clinica e 400, nao lista vazia', async () => {
    const r = await comoMaria(`/tasks?assigneeId=${c.bruno.userId}`)
    expect(r.status).toBe(400)
  })

  it('status=completed ordena do mais recente', async () => {
    const a = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Concluida A' })
    await concluir(c.maria.db, a)
    const b = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Concluida B' })
    await concluir(c.maria.db, b)

    const p = await lista('?status=completed')
    const posA = ids(p).indexOf(a.id)
    const posB = ids(p).indexOf(b.id)
    expect(posB).toBeGreaterThanOrEqual(0)
    expect(posB).toBeLessThan(posA)
  })

  it('status=cancelled e consultavel mesmo sem aba propria', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Cancelada' })
    await cancelar(c.maria.db, t)
    const p = await lista('?status=cancelled')
    expect(ids(p)).toContain(t.id)
  })
})

describe('GET /api/tasks — combinacoes invalidas', () => {
  it.each([
    ['?status=completed&due=today', 'recorte de prazo em status terminal'],
    ['?status=cancelled&due=overdue', 'idem'],
    ['?assignment=mine&assigneeId=00000000-0000-4000-8000-000000000000', 'ambiguo'],
    ['?status=inventado', 'status fora do enum'],
    ['?due=amanha', 'recorte fora do enum'],
    ['?limit=0', 'limite abaixo do minimo'],
    ['?limit=101', 'limite acima do maximo'],
    ['?cursor=nao-e-base64-valido', 'cursor corrompido'],
    ['?clinicId=00000000-0000-4000-8000-000000000000', 'tenant nao vem por query'],
  ])('%s -> 400', async (qs) => {
    const r = await comoMaria(`/tasks${qs}`)
    expect(r.status).toBe(400)
  })
})

describe('GET /api/tasks — ordenacao e paginacao', () => {
  it('due=any apresenta atrasadas, hoje, proximas e sem prazo nessa ordem', async () => {
    const p = await lista('?limit=100')
    const prazos = p.items.map((i) => i.dueAt)
    const comPrazo = prazos.filter((d) => d !== null) as string[]
    const semPrazo = prazos.filter((d) => d === null)

    // Nenhum nulo antes de um nao-nulo.
    expect(prazos.slice(0, comPrazo.length).every((d) => d !== null)).toBe(true)
    expect(semPrazo.length).toBe(prazos.length - comPrazo.length)
    // E os prazos em ordem crescente.
    expect([...comPrazo].sort()).toEqual(comPrazo)
  })

  it('pagina sem perder nem duplicar, inclusive com prazos iguais e nulos', async () => {
    const mesmoPrazo = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const criadas: TaskRow[] = []
    for (let n = 0; n < 6; n += 1) {
      criadas.push(
        await novaTask(c.maria.db, c.maria.clinicId, {
          title: `Empate ${n}`,
          dueAt: n < 4 ? mesmoPrazo : null,
        }),
      )
    }

    const vistos: string[] = []
    let cursor: string | null = null
    let voltas = 0
    do {
      const pagina: Page<TaskListItem> = await lista(
        `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      vistos.push(...ids(pagina))
      cursor = pagina.nextCursor
      voltas += 1
    } while (cursor && voltas < 30)

    expect(new Set(vistos).size).toBe(vistos.length) // sem duplicatas
    for (const t of criadas) expect(vistos).toContain(t.id) // sem perdas
  })

  it('pagina status=completed com completed_at possivelmente igual', async () => {
    for (let n = 0; n < 5; n += 1) {
      const t = await novaTask(c.maria.db, c.maria.clinicId, { title: `Fecha ${n}` })
      await concluir(c.maria.db, t)
    }
    const vistos: string[] = []
    let cursor: string | null = null
    let voltas = 0
    do {
      const pagina: Page<TaskListItem> = await lista(
        `?status=completed&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      vistos.push(...ids(pagina))
      cursor = pagina.nextCursor
      voltas += 1
    } while (cursor && voltas < 30)

    expect(new Set(vistos).size).toBe(vistos.length)
    expect(vistos.length).toBeGreaterThanOrEqual(5)
  })

  it('due=none pagina pela criacao, da mais antiga para a mais nova', async () => {
    const p = await lista('?due=none&limit=100')
    const datas = p.items.map((i) => i.createdAt)
    expect([...datas].sort()).toEqual(datas)
  })
})

describe('GET /api/tasks/:id', () => {
  it('devolve os campos operacionais e o contexto resolvido', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Com paciente',
      description: 'Ligar sobre o horario',
      patientId: c.maria.patientId,
    })
    const r = await comoMaria<TaskDetail>(`/tasks/${t.id}`)
    expect(r.status, r.body.slice(0, 300)).toBe(200)

    expect(r.json.description).toBe('Ligar sobre o horario')
    expect(r.json.version).toBe(1)
    expect(r.json.patient?.id).toBe(c.maria.patientId)
    expect(r.json.patient?.name).toBe(c.maria.patientName)
    expect(r.json.conversation).toBeNull()
    expect(r.json.appointment).toBeNull()
  })

  it('pendencia geral vem com os tres contextos nulos', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Geral da clinica' })
    const r = await comoMaria<TaskDetail>(`/tasks/${t.id}`)
    expect(r.json.patient).toBeNull()
    expect(r.json.conversation).toBeNull()
    expect(r.json.appointment).toBeNull()
  })

  it('resolve conversa e agendamento na mesma resposta', async () => {
    const { data: conv } = await c.maria.db.rpc('conversation_create_manual', {
      p_clinic_id: c.maria.clinicId,
      p_contact_phone_e164: null,
      p_contact_name_snapshot: 'Contato da pendencia',
      p_patient_id: null,
    })
    const conversationId = (conv as { conversation: { id: string } }).conversation.id

    const { data: prof } = await c.admin
      .from('professionals')
      .insert({ clinic_id: c.maria.clinicId, name: 'Dra. Ana' })
      .select('id')
      .single()
    const inicio = new Date(Date.now() + 172_800_000)
    const { data: ag } = await c.admin
      .from('appointments')
      .insert({
        clinic_id: c.maria.clinicId,
        patient_id: c.maria.patientId,
        professional_id: (prof as { id: string }).id,
        starts_at: inicio.toISOString(),
        ends_at: new Date(inicio.getTime() + 1_800_000).toISOString(),
      })
      .select('id')
      .single()
    const appointmentId = (ag as { id: string }).id

    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Contexto completo',
      patientId: c.maria.patientId,
      conversationId,
      appointmentId,
    })

    const r = await comoMaria<TaskDetail>(`/tasks/${t.id}`)
    expect(r.status, r.body.slice(0, 300)).toBe(200)
    expect(r.json.conversation).toMatchObject({
      id: conversationId,
      contactName: 'Contato da pendencia',
    })
    expect(r.json.appointment).toMatchObject({ id: appointmentId, professionalName: 'Dra. Ana' })
    // Resumo, nao prontuario: nada de mensagens nem da agenda inteira.
    expect(Object.keys(r.json.appointment!).sort()).toEqual([
      'id',
      'professionalName',
      'startsAt',
      'status',
    ])
  })

  it('paciente apagado: patientId nulo, sem tentar reconstruir a identidade', async () => {
    const { data: p } = await c.admin
      .from('patients')
      .insert({ clinic_id: c.maria.clinicId, name: 'Some Depois', phone: '11911112222' })
      .select('id')
      .single()
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Paciente vai sumir',
      patientId: (p as { id: string }).id,
    })
    await c.admin.from('patients').delete().eq('id', (p as { id: string }).id)

    const r = await comoMaria<TaskDetail>(`/tasks/${t.id}`)
    expect(r.status).toBe(200)
    expect(r.json.patientId).toBeNull()
    expect(r.json.patient).toBeNull()
  })
})

describe('GET /api/tasks/:id/events', () => {
  it('devolve o historico do mais recente para o mais antigo', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Historico' })
    const assumida = (await assumir(c.maria.db, t)).task!
    await concluir(c.maria.db, assumida)

    const r = await comoMaria<Page<TaskEventView>>(`/tasks/${t.id}/events`)
    expect(r.status, r.body.slice(0, 300)).toBe(200)
    expect(r.json.items.map((e) => e.eventType)).toEqual(['completed', 'assigned', 'created'])
  })

  it('metadata vem tipada por eventType', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Metadata' })
    await assumir(c.maria.db, t)

    const r = await comoMaria<Page<TaskEventView>>(`/tasks/${t.id}/events`)
    const assigned = r.json.items.find((e) => e.eventType === 'assigned')!
    expect(assigned.metadata).toEqual({
      to: { userId: c.maria.userId, displayName: 'Usuario MARIA' },
    })
    const created = r.json.items.find((e) => e.eventType === 'created')!
    expect(created.metadata).toEqual({})
  })

  it('preserva o snapshot depois de a conta do ator sumir', async () => {
    const email = `evsai-${c.registry.testRunId}@example.test`
    const password = `Senha-Teste-${c.registry.testRunId}!`
    const { data: criado } = await c.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Ator Que Sai', test_run_id: c.registry.testRunId },
    })
    const efemero = criado!.user!.id
    c.registry.registerUser(efemero)
    await c.admin
      .from('clinic_members')
      .insert({ clinic_id: c.maria.clinicId, user_id: efemero, role: 'attendant' })

    const { createClient } = await import('@supabase/supabase-js')
    const sessao = createClient(c.env.url, c.env.anonKey)
    await sessao.auth.signInWithPassword({ email, password })
    const t = await novaTask(sessao, c.maria.clinicId, { title: 'Ator vai sumir' })

    await c.admin.auth.admin.deleteUser(efemero)

    const r = await comoMaria<Page<TaskEventView>>(`/tasks/${t.id}/events`)
    const created = r.json.items.find((e) => e.eventType === 'created')!
    expect(created.actorUserId).toBeNull()
    expect(created.actorNameSnapshot).toBe('Ator Que Sai')
    expect(created.actorRoleSnapshot).toBe('attendant')
  })

  it('pagina do mais recente para o mais antigo, sem repetir', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Muitos eventos' })
    const a = (await assumir(c.maria.db, t)).task!
    const f = (await concluir(c.maria.db, a)).task!
    await c.maria.db.rpc('task_reopen', { p_task_id: f.id, p_expected_version: f.version })

    const vistos: string[] = []
    let cursor: string | null = null
    let voltas = 0
    do {
      const url = `/tasks/${t.id}/events?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const p = await comoMaria<Page<TaskEventView>>(url)
      expect(p.status).toBe(200)
      const pagina: Page<TaskEventView> = p.json
      vistos.push(...pagina.items.map((e) => e.id))
      cursor = pagina.nextCursor
      voltas += 1
    } while (cursor && voltas < 20)

    expect(new Set(vistos).size).toBe(vistos.length)
    expect(vistos).toHaveLength(4)
  })

  it('cursor invalido e 400', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Cursor ruim' })
    const r = await comoMaria(`/tasks/${t.id}/events?cursor=xxx`)
    expect(r.status).toBe(400)
  })
})

describe('tenant', () => {
  it('pendencia de outra clinica responde 404 identico ao de uuid inexistente', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Da clinica B' })

    const daOutra = await comoMaria(`/tasks/${alheia.id}`)
    const inexistente = await comoMaria(`/tasks/${UUID_INEXISTENTE}`)

    expect(daOutra.status).toBe(404)
    expect(inexistente.status).toBe(404)
    // Byte a byte: um 403 aqui confirmaria que a pendencia existe.
    expect(daOutra.body).toBe(inexistente.body)
  })

  it('eventos de pendencia alheia respondem 404 igual', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Eventos alheios' })
    const daOutra = await comoMaria(`/tasks/${alheia.id}/events`)
    const inexistente = await comoMaria(`/tasks/${UUID_INEXISTENTE}/events`)
    expect(daOutra.status).toBe(404)
    expect(daOutra.body).toBe(inexistente.body)
  })

  it('a lista nunca inclui pendencia de outra clinica', async () => {
    await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Invisivel para A' })
    const p = await lista('?limit=100')
    const { data } = await c.admin.from('tasks').select('id').eq('clinic_id', c.bruno.clinicId)
    for (const alheia of (data ?? []) as { id: string }[]) {
      expect(ids(p)).not.toContain(alheia.id)
    }
  })

  it('header de clinica alheia nao da acesso', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Header forjado' })
    const r = await get(`/tasks/${alheia.id}`, c.maria.accessToken, c.bruno.clinicId)
    expect([403, 404]).toContain(r.status)
    expect(r.body).not.toContain('Header forjado')
  })

  it('sem token e 401', async () => {
    const r = await fetch(`${c.env.apiUrl}/api/tasks`)
    expect(r.status).toBe(401)
  })
})
