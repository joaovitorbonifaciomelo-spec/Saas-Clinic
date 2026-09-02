/**
 * API de escrita/controle de Pendencias, contra a API e o Supabase reais.
 *
 * Nada aqui insere em `task_events`: a API nao tem esse privilegio, e o evento
 * nasce como consequencia atomica da RPC. Os testes conferem o efeito no
 * historico exatamente por isso — se a API estivesse duplicando auditoria, os
 * contadores de evento apareceriam dobrados.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { Task, TaskDetail } from '@clinicas/shared'
import {
  UUID_INEXISTENTE,
  eventosDe,
  lerTask,
  registrarLimpeza,
  montarCenario,
  novaTask,
  type Cenario,
} from './task-helpers'

let c: Cenario

interface Resposta<T = unknown> {
  status: number
  body: string
  json: T
}

async function req<T = unknown>(
  metodo: string,
  path: string,
  token: string,
  clinicId: string | null,
  payload?: unknown,
): Promise<Resposta<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  if (clinicId) headers['x-clinic-id'] = clinicId
  const r = await fetch(`${c.env.apiUrl}/api${path}`, {
    method: metodo,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  const body = await r.text()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    json = null
  }
  return { status: r.status, body, json: json as T }
}

const maria = <T = unknown,>(m: string, p: string, payload?: unknown) =>
  req<T>(m, p, c.maria.accessToken, c.maria.clinicId, payload)
const joao = <T = unknown,>(m: string, p: string, payload?: unknown) =>
  req<T>(m, p, c.joao.accessToken, c.maria.clinicId, payload)

/** Cria pela API e devolve o detalhe, falhando alto se nao vier 201. */
async function criarPelaApi(payload: Record<string, unknown>): Promise<TaskDetail> {
  const r = await maria<TaskDetail>('POST', '/tasks', payload)
  expect(r.status, r.body.slice(0, 300)).toBe(201)
  return r.json
}

const contarEventos = async (taskId: string, tipo: string) =>
  (await eventosDe(c.admin, taskId)).filter((e) => e.event_type === tipo).length

beforeAll(async () => {
  c = await montarCenario()
  const saude = await fetch(`${c.env.apiUrl}/api/health`).catch(() => null)
  if (!saude?.ok) throw new Error(`API precisa estar no ar em ${c.env.apiUrl}.`)
}, 120_000)

registrarLimpeza(() => c)

/* =========================================================================
   CREATE
   ====================================================================== */

describe('POST /api/tasks', () => {
  it('cria pendencia geral e devolve 201 com o read model de detalhe', async () => {
    const t = await criarPelaApi({ title: 'Revisar encaixes de amanha' })
    expect(t.status).toBe('open')
    expect(t.version).toBe(1)
    expect(t.createdBy).toBe(c.maria.userId)
    expect(t.patient).toBeNull()
    expect(t.conversation).toBeNull()
    expect(t.appointment).toBeNull()
    expect(await contarEventos(t.id, 'created')).toBe(1)
  })

  it('cria com paciente, prazo e responsavel', async () => {
    const prazo = new Date(Date.now() + 86_400_000).toISOString()
    const t = await criarPelaApi({
      title: 'Cobrar documento',
      description: 'Ligar sobre o pedido de exame',
      dueAt: prazo,
      assignedTo: c.joao.userId,
      patientId: c.maria.patientId,
    })
    expect(t.description).toBe('Ligar sobre o pedido de exame')
    expect(t.dueAt).not.toBeNull()
    expect(t.assignee?.userId).toBe(c.joao.userId)
    expect(t.patient?.id).toBe(c.maria.patientId)
  })

  it('cria com conversa e agendamento juntos', async () => {
    const { data: conv } = await c.maria.db.rpc('conversation_create_manual', {
      p_clinic_id: c.maria.clinicId,
      p_contact_phone_e164: null,
      p_contact_name_snapshot: 'Contato da criacao',
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

    const t = await criarPelaApi({
      title: 'Contexto completo',
      patientId: c.maria.patientId,
      conversationId,
      appointmentId: (ag as { id: string }).id,
    })
    expect(t.conversation?.id).toBe(conversationId)
    expect(t.appointment?.professionalName).toBe('Dra. Ana')
  })

  it('conversa vinculada a outro paciente e 409 task_patient_mismatch', async () => {
    const { data: conv } = await c.maria.db.rpc('conversation_create_manual', {
      p_clinic_id: c.maria.clinicId,
      p_contact_phone_e164: null,
      p_contact_name_snapshot: 'Conversa vinculada',
      p_patient_id: null,
    })
    const conversationId = (conv as { conversation: { id: string } }).conversation.id
    await c.maria.db.rpc('conversation_link_patient', {
      p_conversation_id: conversationId,
      p_expected_version: 1,
      p_patient_id: c.maria.patientId,
    })
    const { data: outro } = await c.admin
      .from('patients')
      .insert({ clinic_id: c.maria.clinicId, name: 'Outro Paciente', phone: '11955554444' })
      .select('id')
      .single()

    const r = await maria<{ error: string; current?: unknown }>('POST', '/tasks', {
      title: 'Incoerente',
      conversationId,
      patientId: (outro as { id: string }).id,
    })

    expect(r.status).toBe(409)
    expect(r.json.error).toBe('task_patient_mismatch')
    // Sem `current`: a pendencia nem chegou a existir.
    expect(r.json.current).toBeUndefined()
  })

  it.each([
    ['paciente inexistente', { patientId: UUID_INEXISTENTE }],
    ['conversa inexistente', { conversationId: UUID_INEXISTENTE }],
    ['agendamento inexistente', { appointmentId: UUID_INEXISTENTE }],
  ])('referencia %s devolve 404 sem revelar existencia', async (_n, extra) => {
    const r = await maria('POST', '/tasks', { title: 'Referencia ruim', ...extra })
    expect(r.status).toBe(404)
  })

  it('referencias cross-tenant respondem igual a inexistentes', async () => {
    const doOutro = await maria('POST', '/tasks', {
      title: 'Paciente de outra clinica',
      patientId: c.bruno.patientId,
    })
    const inexistente = await maria('POST', '/tasks', {
      title: 'Paciente de outra clinica',
      patientId: UUID_INEXISTENTE,
    })
    expect(doOutro.status).toBe(404)
    expect(doOutro.body).toBe(inexistente.body)
  })

  it('responsavel de outra clinica devolve 404', async () => {
    const r = await maria('POST', '/tasks', {
      title: 'Responsavel de fora',
      assignedTo: c.bruno.userId,
    })
    expect(r.status).toBe(404)
  })

  it.each([
    ['clinicId', { clinicId: '00000000-0000-4000-8000-000000000000' }],
    ['status', { status: 'completed' }],
    ['version', { version: 5 }],
    ['createdBy', { createdBy: '00000000-0000-4000-8000-000000000000' }],
    ['completedBy', { completedBy: '00000000-0000-4000-8000-000000000000' }],
    ['cancelledBy', { cancelledBy: '00000000-0000-4000-8000-000000000000' }],
    ['createdAt', { createdAt: '2026-01-01T00:00:00.000Z' }],
    ['updatedAt', { updatedAt: '2026-01-01T00:00:00.000Z' }],
    ['actorUserId', { actorUserId: '00000000-0000-4000-8000-000000000000' }],
    ['metadata', { metadata: { qualquer: 'coisa' } }],
    ['eventType', { eventType: 'created' }],
    ['expectedVersion', { expectedVersion: 1 }],
  ])('recusa %s no corpo com 400, em vez de descartar em silencio', async (_n, extra) => {
    const r = await maria('POST', '/tasks', { title: 'Campo proibido', ...extra })
    expect(r.status).toBe(400)
  })

  it('nao cria a pendencia quando o corpo e recusado', async () => {
    const antes = await maria<{ items: unknown[] }>('GET', '/tasks?limit=100')
    await maria('POST', '/tasks', { title: 'Nao deve nascer', status: 'completed' })
    const depois = await maria<{ items: unknown[] }>('GET', '/tasks?limit=100')
    expect(depois.json.items.length).toBe(antes.json.items.length)
  })
})

/* =========================================================================
   DETAILS
   ====================================================================== */

describe('PATCH /api/tasks/:id/details', () => {
  it('altera o titulo, sobe a versao e gera um details_changed', async () => {
    const t = await criarPelaApi({ title: 'Titulo velho' })
    const r = await maria<Task>('PATCH', `/tasks/${t.id}/details`, {
      title: 'Titulo novo',
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.title).toBe('Titulo novo')
    expect(r.json.version).toBe(2)
    expect(await contarEventos(t.id, 'details_changed')).toBe(1)
  })

  it('texto identico e no-op: 200, mesma versao, zero evento', async () => {
    const t = await criarPelaApi({ title: 'Texto igual' })
    const r = await maria<Task>('PATCH', `/tasks/${t.id}/details`, {
      title: 'Texto igual',
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.version).toBe(t.version)
    expect(await contarEventos(t.id, 'details_changed')).toBe(0)
  })

  it('description ausente nao apaga; description null apaga', async () => {
    const t = await criarPelaApi({ title: 'Com descricao', description: 'instrucao' })
    const semCampo = await maria<Task>('PATCH', `/tasks/${t.id}/details`, {
      title: 'Outro titulo',
      expectedVersion: t.version,
    })
    expect(semCampo.json.description).toBe('instrucao')

    const comNull = await maria<Task>('PATCH', `/tasks/${t.id}/details`, {
      description: null,
      expectedVersion: semCampo.json.version,
    })
    expect(comNull.json.description).toBeNull()
  })

  it('versao obsoleta e 409 task_conflict com o estado atual', async () => {
    const t = await criarPelaApi({ title: 'Stale' })
    await maria('PATCH', `/tasks/${t.id}/details`, {
      title: 'Primeira alteracao',
      expectedVersion: t.version,
    })
    const r = await maria<{ error: string; current: Task }>(
      'PATCH',
      `/tasks/${t.id}/details`,
      { title: 'Segunda', expectedVersion: t.version },
    )
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('task_conflict')
    expect(r.json.current.version).toBe(2)
    expect(r.json.current.title).toBe('Primeira alteracao')
  })

  it('pendencia terminal e 409 invalid_state com reason=terminal', async () => {
    const t = await criarPelaApi({ title: 'Congelada' })
    const feita = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    const r = await maria<{ error: string; reason: string; current: Task }>(
      'PATCH',
      `/tasks/${t.id}/details`,
      { title: 'Tentativa tardia', expectedVersion: feita.json.version },
    )
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('task_invalid_state')
    expect(r.json.reason).toBe('terminal')
    expect(r.json.current.status).toBe('completed')
  })

  it('exige expectedVersion no corpo, e nao aceita por query string', async () => {
    const t = await criarPelaApi({ title: 'Sem versao' })
    const semVersao = await maria('PATCH', `/tasks/${t.id}/details`, { title: 'Nova' })
    const naQuery = await maria('PATCH', `/tasks/${t.id}/details?expectedVersion=1`, {
      title: 'Nova',
    })
    expect(semVersao.status).toBe(400)
    expect(naQuery.status).toBe(400)
  })
})

/* =========================================================================
   ASSIGN / TRANSFER / RELEASE
   ====================================================================== */

describe('POST /api/tasks/:id/assign', () => {
  it('atribui a si mesmo, sobe a versao e gera assigned', async () => {
    const t = await criarPelaApi({ title: 'Assumir' })
    const r = await maria<Task>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.maria.userId,
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.assignedTo).toBe(c.maria.userId)
    expect(r.json.version).toBe(2)
    expect(await contarEventos(t.id, 'assigned')).toBe(1)
  })

  it('ja atribuida e 409 invalid_state/already_assigned, sem sobrescrever', async () => {
    const t = await criarPelaApi({ title: 'Ja tem dono' })
    const minha = await maria<Task>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.maria.userId,
      expectedVersion: t.version,
    })
    const r = await joao<{ error: string; reason: string }>(
      'POST',
      `/tasks/${t.id}/assign`,
      { assigneeId: c.joao.userId, expectedVersion: minha.json.version },
    )
    expect(r.status).toBe(409)
    expect(r.json.reason).toBe('already_assigned')
    expect((await lerTask(c.admin, t.id))?.assigned_to).toBe(c.maria.userId)
  })

  it('terminal e 409 invalid_state/terminal', async () => {
    const t = await criarPelaApi({ title: 'Terminal assign' })
    const feita = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    const r = await maria<{ reason: string }>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.maria.userId,
      expectedVersion: feita.json.version,
    })
    expect(r.status).toBe(409)
    expect(r.json.reason).toBe('terminal')
  })

  it('versao obsoleta e conflict', async () => {
    const t = await criarPelaApi({ title: 'Assign stale' })
    await maria('PATCH', `/tasks/${t.id}/details`, {
      title: 'Mudou',
      expectedVersion: t.version,
    })
    const r = await maria<{ error: string }>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.maria.userId,
      expectedVersion: t.version,
    })
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('task_conflict')
  })

  it('atribuir a OUTRA pessoa e recusado com 400 explicito nesta versao', async () => {
    // Limite do banco: `task_assign` atribui a auth.uid() e nao aceita
    // destinatario. Recusar e melhor do que atribuir a si mesmo em silencio.
    const t = await criarPelaApi({ title: 'Para o Joao' })
    const r = await maria<{ message: string }>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.joao.userId,
      expectedVersion: t.version,
    })
    expect(r.status).toBe(400)
    expect((await lerTask(c.admin, t.id))?.assigned_to).toBeNull()
  })
})

describe('POST /api/tasks/:id/transfer', () => {
  const comDono = async (titulo: string) => {
    const t = await criarPelaApi({ title: titulo })
    const r = await maria<Task>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.maria.userId,
      expectedVersion: t.version,
    })
    return r.json
  }

  it('transfere para outro membro e gera transferred', async () => {
    const t = await comDono('Transferir')
    const r = await maria<Task>('POST', `/tasks/${t.id}/transfer`, {
      assigneeId: c.joao.userId,
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.assignedTo).toBe(c.joao.userId)
    expect(await contarEventos(t.id, 'transferred')).toBe(1)
  })

  it('mesmo destino e no-op: 200, mesma versao, zero evento', async () => {
    const t = await comDono('Mesmo destino')
    const r = await maria<Task>('POST', `/tasks/${t.id}/transfer`, {
      assigneeId: c.maria.userId,
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.version).toBe(t.version)
    expect(await contarEventos(t.id, 'transferred')).toBe(0)
  })

  it('sem responsavel e invalid_state/not_assigned, nao vira assign', async () => {
    const t = await criarPelaApi({ title: 'Sem dono' })
    const r = await maria<{ reason: string }>('POST', `/tasks/${t.id}/transfer`, {
      assigneeId: c.joao.userId,
      expectedVersion: t.version,
    })
    expect(r.status).toBe(409)
    expect(r.json.reason).toBe('not_assigned')
    expect((await lerTask(c.admin, t.id))?.assigned_to).toBeNull()
  })

  it('destino de outra clinica e 404, igual a destino inexistente', async () => {
    const t = await comDono('Destino de fora')
    const alheio = await maria('POST', `/tasks/${t.id}/transfer`, {
      assigneeId: c.bruno.userId,
      expectedVersion: t.version,
    })
    const inexistente = await maria('POST', `/tasks/${t.id}/transfer`, {
      assigneeId: UUID_INEXISTENTE,
      expectedVersion: t.version,
    })
    expect(alheio.status).toBe(404)
    expect(alheio.body).toBe(inexistente.body)
  })

  it('terminal e stale seguem a precedencia aprovada', async () => {
    const t = await comDono('Precedencia transfer')
    const feita = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    const terminal = await maria<{ reason: string }>('POST', `/tasks/${t.id}/transfer`, {
      assigneeId: c.joao.userId,
      expectedVersion: feita.json.version,
    })
    const stale = await maria<{ error: string }>('POST', `/tasks/${t.id}/transfer`, {
      assigneeId: c.joao.userId,
      expectedVersion: t.version,
    })
    expect(terminal.json.reason).toBe('terminal')
    // Versao velha em pendencia terminal: a resposta e sobre a VERSAO.
    expect(stale.json.error).toBe('task_conflict')
  })
})

describe('POST /api/tasks/:id/release', () => {
  it('devolve a fila, zera o responsavel e gera released', async () => {
    const t = await criarPelaApi({ title: 'Devolver' })
    const minha = await maria<Task>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.maria.userId,
      expectedVersion: t.version,
    })
    const r = await maria<Task>('POST', `/tasks/${t.id}/release`, {
      expectedVersion: minha.json.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.assignedTo).toBeNull()
    expect(await contarEventos(t.id, 'released')).toBe(1)
  })

  it('ja sem responsavel e no-op', async () => {
    const t = await criarPelaApi({ title: 'Ja na fila' })
    const r = await maria<Task>('POST', `/tasks/${t.id}/release`, {
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.version).toBe(t.version)
    expect(await contarEventos(t.id, 'released')).toBe(0)
  })

  it('stale e terminal seguem o contrato', async () => {
    const t = await criarPelaApi({ title: 'Release contrato' })
    const feita = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    const terminal = await maria<{ reason: string }>('POST', `/tasks/${t.id}/release`, {
      expectedVersion: feita.json.version,
    })
    const stale = await maria<{ error: string }>('POST', `/tasks/${t.id}/release`, {
      expectedVersion: t.version,
    })
    expect(terminal.json.reason).toBe('terminal')
    expect(stale.json.error).toBe('task_conflict')
  })
})

/* =========================================================================
   DUE
   ====================================================================== */

describe('PATCH /api/tasks/:id/due', () => {
  const prazo = (deslocamentoMs: number) =>
    new Date(Date.now() + deslocamentoMs).toISOString()

  it('define, altera e remove o prazo', async () => {
    const t = await criarPelaApi({ title: 'Prazo' })
    const definido = await maria<Task>('PATCH', `/tasks/${t.id}/due`, {
      dueAt: prazo(86_400_000),
      expectedVersion: t.version,
    })
    expect(definido.status).toBe(200)
    expect(definido.json.dueAt).not.toBeNull()

    const alterado = await maria<Task>('PATCH', `/tasks/${t.id}/due`, {
      dueAt: prazo(172_800_000),
      expectedVersion: definido.json.version,
    })
    const removido = await maria<Task>('PATCH', `/tasks/${t.id}/due`, {
      dueAt: null,
      expectedVersion: alterado.json.version,
    })
    expect(removido.json.dueAt).toBeNull()
    expect(await contarEventos(t.id, 'due_changed')).toBe(3)
  })

  it('aceita instante no passado: registrar algo que ja venceu e legitimo', async () => {
    const t = await criarPelaApi({ title: 'Ja deveria estar feito' })
    const r = await maria<Task>('PATCH', `/tasks/${t.id}/due`, {
      dueAt: prazo(-604_800_000),
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.dueAt).not.toBeNull()
  })

  it('prazo identico e no-op', async () => {
    const quando = prazo(86_400_000)
    const t = await criarPelaApi({ title: 'Prazo igual', dueAt: quando })
    const r = await maria<Task>('PATCH', `/tasks/${t.id}/due`, {
      dueAt: quando,
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.version).toBe(t.version)
    expect(await contarEventos(t.id, 'due_changed')).toBe(0)
  })

  it('recusa data sem fuso: a API recebe instante, nao hora local', async () => {
    const t = await criarPelaApi({ title: 'Sem fuso' })
    for (const ruim of ['2026-09-01', '2026-09-01T10:00:00', 'amanha']) {
      const r = await maria('PATCH', `/tasks/${t.id}/due`, {
        dueAt: ruim,
        expectedVersion: t.version,
      })
      expect(r.status, `aceitou ${ruim}`).toBe(400)
    }
  })

  it('dueAt omitido e 400: omitir seria ambiguo entre manter e remover', async () => {
    const t = await criarPelaApi({ title: 'Due omitido' })
    const r = await maria('PATCH', `/tasks/${t.id}/due`, { expectedVersion: t.version })
    expect(r.status).toBe(400)
  })

  it('stale e terminal seguem o contrato', async () => {
    const t = await criarPelaApi({ title: 'Due contrato' })
    const feita = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    const terminal = await maria<{ reason: string }>('PATCH', `/tasks/${t.id}/due`, {
      dueAt: prazo(3_600_000),
      expectedVersion: feita.json.version,
    })
    const stale = await maria<{ error: string }>('PATCH', `/tasks/${t.id}/due`, {
      dueAt: prazo(3_600_000),
      expectedVersion: t.version,
    })
    expect(terminal.json.reason).toBe('terminal')
    expect(stale.json.error).toBe('task_conflict')
  })
})

/* =========================================================================
   COMPLETE / CANCEL / REOPEN
   ====================================================================== */

describe('ciclo de status', () => {
  it('concluir: 200, carimbo, versao +1 e evento', async () => {
    const t = await criarPelaApi({ title: 'Concluir' })
    const r = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('completed')
    expect(r.json.completedBy).toBe(c.maria.userId)
    expect(r.json.completedAt).not.toBeNull()
    expect(r.json.version).toBe(2)
    expect(await contarEventos(t.id, 'completed')).toBe(1)
  })

  it('concluir de novo e no-op', async () => {
    const t = await criarPelaApi({ title: 'Concluir duas vezes' })
    const feita = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    const r = await maria<Task>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: feita.json.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.version).toBe(feita.json.version)
    expect(await contarEventos(t.id, 'completed')).toBe(1)
  })

  it('cancelar: 200, carimbo e evento', async () => {
    const t = await criarPelaApi({ title: 'Cancelar' })
    const r = await maria<Task>('POST', `/tasks/${t.id}/cancel`, {
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('cancelled')
    expect(r.json.cancelledBy).toBe(c.maria.userId)
    expect(await contarEventos(t.id, 'cancelled')).toBe(1)
  })

  it('cancelar de novo e no-op', async () => {
    const t = await criarPelaApi({ title: 'Cancelar duas vezes' })
    const cancelada = await maria<Task>('POST', `/tasks/${t.id}/cancel`, {
      expectedVersion: t.version,
    })
    const r = await maria<Task>('POST', `/tasks/${t.id}/cancel`, {
      expectedVersion: cancelada.json.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.version).toBe(cancelada.json.version)
    expect(await contarEventos(t.id, 'cancelled')).toBe(1)
  })

  it('cancelada -> concluir e invalid_transition, e vice-versa', async () => {
    const cancelada = await criarPelaApi({ title: 'Cancelada' })
    const c1 = await maria<Task>('POST', `/tasks/${cancelada.id}/cancel`, {
      expectedVersion: cancelada.version,
    })
    const r1 = await maria<{ reason: string }>('POST', `/tasks/${cancelada.id}/complete`, {
      expectedVersion: c1.json.version,
    })

    const concluida = await criarPelaApi({ title: 'Concluida' })
    const c2 = await maria<Task>('POST', `/tasks/${concluida.id}/complete`, {
      expectedVersion: concluida.version,
    })
    const r2 = await maria<{ reason: string }>('POST', `/tasks/${concluida.id}/cancel`, {
      expectedVersion: c2.json.version,
    })

    expect(r1.status).toBe(409)
    expect(r1.json.reason).toBe('invalid_transition')
    expect(r2.json.reason).toBe('invalid_transition')
  })

  it('reabrir de completed e de cancelled limpa o carimbo e preserva o historico', async () => {
    for (const acao of ['complete', 'cancel'] as const) {
      const t = await criarPelaApi({ title: `Reabrir de ${acao}` })
      const terminal = await maria<Task>('POST', `/tasks/${t.id}/${acao}`, {
        expectedVersion: t.version,
      })
      const r = await maria<Task>('POST', `/tasks/${t.id}/reopen`, {
        expectedVersion: terminal.json.version,
      })
      expect(r.status).toBe(200)
      expect(r.json.status).toBe('open')
      expect(r.json.completedAt).toBeNull()
      expect(r.json.cancelledAt).toBeNull()

      // O fato de ter passado pelo estado terminal NAO se perde.
      const tipos = (await eventosDe(c.admin, t.id)).map((e) => e.event_type)
      expect(tipos).toContain(acao === 'complete' ? 'completed' : 'cancelled')
      expect(tipos).toContain('reopened')
    }
  })

  it('reabrir uma pendencia aberta e no-op', async () => {
    const t = await criarPelaApi({ title: 'Reabrir aberta' })
    const r = await maria<Task>('POST', `/tasks/${t.id}/reopen`, {
      expectedVersion: t.version,
    })
    expect(r.status).toBe(200)
    expect(r.json.version).toBe(t.version)
    expect(await contarEventos(t.id, 'reopened')).toBe(0)
  })

  it('stale tem precedencia sobre a regra de estado', async () => {
    const t = await criarPelaApi({ title: 'Precedencia status' })
    await maria('PATCH', `/tasks/${t.id}/details`, {
      title: 'Mudou',
      expectedVersion: t.version,
    })
    const r = await maria<{ error: string }>('POST', `/tasks/${t.id}/complete`, {
      expectedVersion: t.version,
    })
    expect(r.json.error).toBe('task_conflict')
  })
})

/* =========================================================================
   CONCORRENCIA PELA API
   ====================================================================== */

describe('corridas reais atraves da API', () => {
  const umVence = (a: Resposta, b: Resposta) => ({
    oks: [a, b].filter((r) => r.status === 200).length,
    conflitos: [a, b].filter(
      (r) => r.status === 409 && (r.json as { error?: string }).error === 'task_conflict',
    ).length,
  })

  it('concluir x cancelar: um vence, um conflita, um unico evento', async () => {
    const t = await criarPelaApi({ title: 'Concluir x cancelar' })
    const [x, y] = await Promise.all([
      maria('POST', `/tasks/${t.id}/complete`, { expectedVersion: t.version }),
      joao('POST', `/tasks/${t.id}/cancel`, { expectedVersion: t.version }),
    ])
    expect(umVence(x, y)).toEqual({ oks: 1, conflitos: 1 })

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.version).toBe(2)
    const carimbos = [linha?.completed_at, linha?.cancelled_at].filter(Boolean)
    expect(carimbos).toHaveLength(1)

    const eventos = (await eventosDe(c.admin, t.id)).filter((e) => e.event_type !== 'created')
    expect(eventos).toHaveLength(1)
  })

  it('transferir x devolver: um vence, um conflita', async () => {
    const t = await criarPelaApi({ title: 'Transferir x devolver' })
    const minha = await maria<Task>('POST', `/tasks/${t.id}/assign`, {
      assigneeId: c.maria.userId,
      expectedVersion: t.version,
    })
    const v = minha.json.version

    const [x, y] = await Promise.all([
      maria('POST', `/tasks/${t.id}/transfer`, {
        assigneeId: c.joao.userId,
        expectedVersion: v,
      }),
      joao('POST', `/tasks/${t.id}/release`, { expectedVersion: v }),
    ])
    expect(umVence(x, y)).toEqual({ oks: 1, conflitos: 1 })

    expect((await lerTask(c.admin, t.id))?.version).toBe(v + 1)
    const eventos = (await eventosDe(c.admin, t.id)).filter((e) =>
      ['transferred', 'released'].includes(e.event_type),
    )
    expect(eventos).toHaveLength(1)
  })

  it('prazo x texto: um vence, um conflita', async () => {
    const t = await criarPelaApi({ title: 'Prazo x texto' })
    const [x, y] = await Promise.all([
      maria('PATCH', `/tasks/${t.id}/due`, {
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        expectedVersion: t.version,
      }),
      joao('PATCH', `/tasks/${t.id}/details`, {
        title: 'Titulo do Joao',
        expectedVersion: t.version,
      }),
    ])
    expect(umVence(x, y)).toEqual({ oks: 1, conflitos: 1 })

    expect((await lerTask(c.admin, t.id))?.version).toBe(2)
    const eventos = (await eventosDe(c.admin, t.id)).filter((e) =>
      ['due_changed', 'details_changed'].includes(e.event_type),
    )
    expect(eventos).toHaveLength(1)
  })
})

/* =========================================================================
   TENANT
   ====================================================================== */

describe('tenant e non-disclosure', () => {
  const familias = (id: string): [string, string, string, unknown][] => [
    ['PATCH', `/tasks/${id}/details`, 'details', { title: 'Titulo valido', expectedVersion: 1 }],
    ['POST', `/tasks/${id}/assign`, 'assign', { assigneeId: c.maria.userId, expectedVersion: 1 }],
    ['POST', `/tasks/${id}/transfer`, 'transfer', { assigneeId: c.joao.userId, expectedVersion: 1 }],
    ['POST', `/tasks/${id}/release`, 'release', { expectedVersion: 1 }],
    ['PATCH', `/tasks/${id}/due`, 'due', { dueAt: null, expectedVersion: 1 }],
    ['POST', `/tasks/${id}/complete`, 'complete', { expectedVersion: 1 }],
    ['POST', `/tasks/${id}/cancel`, 'cancel', { expectedVersion: 1 }],
    ['POST', `/tasks/${id}/reopen`, 'reopen', { expectedVersion: 1 }],
  ]

  it('cada familia de mutacao responde igual para alheia e inexistente', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Da clinica B' })

    for (const [metodo, path, nome, payload] of familias(alheia.id)) {
      const daOutra = await maria(metodo, path, payload)
      const inexistente = await maria(
        metodo,
        path.replace(alheia.id, UUID_INEXISTENTE),
        payload,
      )
      expect(daOutra.status, nome).toBe(404)
      // Byte a byte: qualquer diferenca aqui revelaria que a pendencia existe.
      expect(daOutra.body, nome).toBe(inexistente.body)
    }
  })

  it('nao altera a pendencia da outra clinica', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Intocada' })
    await maria('POST', `/tasks/${alheia.id}/complete`, { expectedVersion: alheia.version })
    const linha = await lerTask(c.admin, alheia.id)
    expect(linha?.status).toBe('open')
    expect(linha?.version).toBe(1)
  })

  it('header de clinica alheia nao da acesso', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Header forjado' })
    const r = await req(
      'POST',
      `/tasks/${alheia.id}/complete`,
      c.maria.accessToken,
      c.bruno.clinicId,
      { expectedVersion: alheia.version },
    )
    expect([403, 404]).toContain(r.status)
  })

  it('sem token e 401 em toda mutacao', async () => {
    const t = await criarPelaApi({ title: 'Sem token' })
    const r = await fetch(`${c.env.apiUrl}/api/tasks/${t.id}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: t.version }),
    })
    expect(r.status).toBe(401)
  })
})
