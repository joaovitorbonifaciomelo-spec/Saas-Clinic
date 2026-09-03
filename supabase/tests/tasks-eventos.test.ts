/**
 * `task_events` contra o Supabase real: append-only, carimbado pelo servidor,
 * com metadata estrita por tipo.
 *
 * O que estas asserções protegem: se o cliente conseguisse inserir um evento,
 * ou escolher o ator, o historico deixaria de ser auditoria e viraria alegacao.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  atribuir,
  cancelar,
  concluir,
  definirPrazo,
  devolver,
  editar,
  eventosDe,
  montarCenario,
  novaTask,
  reabrir,
  transferir,
  type Cenario,
  registrarLimpeza,
} from './task-helpers'

let c: Cenario

beforeAll(async () => {
  c = await montarCenario()
}, 120_000)

registrarLimpeza(() => c)

describe('um evento por operacao', () => {
  it('criacao gera created, e apenas ele', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'So criada' })
    const eventos = await eventosDe(c.admin, t.id)
    expect(eventos.map((e) => e.event_type)).toEqual(['created'])
    expect(eventos[0]!.metadata).toEqual({})
  })

  it('nascer atribuida NAO inventa um evento assigned', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Nasce com dono',
      assignee: c.joao.userId,
    })
    const eventos = await eventosDe(c.admin, t.id)

    // Uma decisao humana, um evento. Dois eventos contariam uma sequencia que
    // nao aconteceu.
    expect(eventos.map((e) => e.event_type)).toEqual(['created'])
    expect(eventos[0]!.metadata).toMatchObject({ assignedTo: { userId: c.joao.userId } })
  })

  it('o responsavel inicial sobrevive a remocao da pessoa da clinica', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Dono inicial some',
      assignee: c.joao.userId,
    })

    await c.admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', c.maria.clinicId)
      .eq('user_id', c.joao.userId)

    const { data: linha } = await c.admin
      .from('tasks')
      .select('assigned_to')
      .eq('id', t.id)
      .single()
    const eventos = await eventosDe(c.admin, t.id)

    // A coluna perde o vinculo (SET NULL, sem evento). O historico e o unico
    // lugar onde "quem era o responsavel inicial" continua existindo — e este
    // e exatamente o buraco que a metadata de `created` tapa.
    expect((linha as { assigned_to: string | null }).assigned_to).toBeNull()
    expect(eventos[0]!.metadata).toMatchObject({ assignedTo: { userId: c.joao.userId } })

    await c.admin
      .from('clinic_members')
      .insert({ clinic_id: c.maria.clinicId, user_id: c.joao.userId, role: 'attendant' })
  })

  it('cada operacao de controle gera o seu evento, na ordem', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Ciclo completo' })
    const a = (await atribuir(c.maria.db, t, c.maria.userId)).task!
    const tr = (await transferir(c.maria.db, a, c.joao.userId)).task!
    const rl = (await devolver(c.maria.db, tr)).task!
    const dd = (await definirPrazo(c.maria.db, rl, new Date(Date.now() + 3_600_000).toISOString()))
      .task!
    const ed = (await editar(c.maria.db, dd, { title: 'Ciclo completo v2' })).task!
    const cp = (await concluir(c.maria.db, ed)).task!
    await reabrir(c.maria.db, cp)

    const tipos = (await eventosDe(c.admin, t.id)).map((e) => e.event_type)
    expect(tipos).toEqual([
      'created',
      'assigned',
      'transferred',
      'released',
      'due_changed',
      'details_changed',
      'completed',
      'reopened',
    ])
  })
})

describe('metadata por tipo', () => {
  it('details_changed guarda so os nomes dos campos', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Texto antigo',
      description: 'descricao antiga',
    })
    const r = await editar(c.maria.db, t, {
      title: 'Texto novo',
      description: 'descricao nova',
      setDescription: true,
    })
    expect(r.outcome).toBe('ok')

    const ev = (await eventosDe(c.admin, t.id)).find((e) => e.event_type === 'details_changed')!
    expect(ev.metadata).toEqual({ fields: ['title', 'description'] })

    // Nem o texto velho nem o novo podem estar no historico: description vai a
    // 2000 caracteres e o teto e 2048 bytes.
    expect(JSON.stringify(ev.metadata)).not.toContain('antiga')
    expect(JSON.stringify(ev.metadata)).not.toContain('nova')
  })

  it('due_changed guarda from e to', async () => {
    const prazo = new Date(Date.now() + 7_200_000).toISOString()
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Prazo' })
    await definirPrazo(c.maria.db, t, prazo)

    const ev = (await eventosDe(c.admin, t.id)).find((e) => e.event_type === 'due_changed')!
    expect(ev.metadata).toHaveProperty('from', null)
    expect(ev.metadata).toHaveProperty('to')
    expect(Object.keys(ev.metadata).sort()).toEqual(['from', 'to'])
  })

  it('assigned, transferred e released guardam snapshot do responsavel', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Snapshots' })
    const a = (await atribuir(c.maria.db, t, c.maria.userId)).task!
    const tr = (await transferir(c.maria.db, a, c.joao.userId)).task!
    await devolver(c.maria.db, tr)

    const eventos = await eventosDe(c.admin, t.id)
    const assigned = eventos.find((e) => e.event_type === 'assigned')!
    const transferred = eventos.find((e) => e.event_type === 'transferred')!
    const released = eventos.find((e) => e.event_type === 'released')!

    expect(assigned.metadata).toMatchObject({ to: { userId: c.maria.userId } })
    expect(transferred.metadata).toMatchObject({
      from: { userId: c.maria.userId },
      to: { userId: c.joao.userId },
    })
    expect(released.metadata).toMatchObject({ from: { userId: c.joao.userId } })

    // Sem `role`: o papel do ATOR ja esta na coluna do evento, e o de quem
    // recebeu nao responde pergunta historica nenhuma.
    const to = (assigned.metadata as { to: Record<string, unknown> }).to
    expect(Object.keys(to).sort()).toEqual(['displayName', 'userId'])
  })

  it('completed, cancelled e reopened tem metadata vazia', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Vazios' })
    const feita = (await concluir(c.maria.db, t)).task!
    const reaberta = (await reabrir(c.maria.db, feita)).task!
    await cancelar(c.maria.db, reaberta)

    const eventos = await eventosDe(c.admin, t.id)
    for (const tipo of ['completed', 'reopened', 'cancelled']) {
      expect(eventos.find((e) => e.event_type === tipo)!.metadata).toEqual({})
    }
  })
})

describe('append-only e autoria', () => {
  it('authenticated nao insere, nao altera e nao apaga evento', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Historico blindado' })

    const insert = await c.maria.db.from('task_events').insert({
      clinic_id: c.maria.clinicId,
      task_id: t.id,
      event_type: 'completed',
    })
    const update = await c.maria.db
      .from('task_events')
      .update({ event_type: 'cancelled' })
      .eq('task_id', t.id)
    const del = await c.maria.db.from('task_events').delete().eq('task_id', t.id)

    expect(insert.error).not.toBeNull()
    expect(update.error).not.toBeNull()
    expect(del.error).not.toBeNull()

    const eventos = await eventosDe(c.admin, t.id)
    expect(eventos.map((e) => e.event_type)).toEqual(['created'])
  })

  it('o ator vem do JWT, com nome e papel carimbados pelo servidor', async () => {
    const t = await novaTask(c.joao.db, c.maria.clinicId, { title: 'Ator do Joao' })
    const ev = (await eventosDe(c.admin, t.id))[0]!
    expect(ev.actor_user_id).toBe(c.joao.userId)
    expect(ev.actor_name_snapshot).toBe('Colega JOAO')
    expect(ev.actor_role_snapshot).toBe('attendant')
  })

  it('authenticated LE os eventos da propria clinica', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Leitura permitida' })
    const { data, error } = await c.maria.db
      .from('task_events')
      .select('event_type')
      .eq('task_id', t.id)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })
})
