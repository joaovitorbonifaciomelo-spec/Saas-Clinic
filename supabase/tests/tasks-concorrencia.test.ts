/**
 * Concorrencia real contra o Supabase.
 *
 * "Real" significa `Promise.all`: as duas requisicoes saem juntas, por conexoes
 * diferentes, com JWTs diferentes. Serializar deliberadamente provaria apenas
 * que o codigo roda em ordem — nao que a corrida tem vencedor unico.
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
  lerTask,
  montarCenario,
  novaTask,
  reabrir,
  transferir,
  type Cenario,
  type Resultado,
  registrarLimpeza,
} from './task-helpers'

let c: Cenario

beforeAll(async () => {
  c = await montarCenario()
}, 120_000)

registrarLimpeza(() => c)

/** Exatamente um `ok`, exatamente um `conflict`. */
function umVence(resultados: Resultado[]) {
  const oks = resultados.filter((r) => r.outcome === 'ok')
  const conflitos = resultados.filter((r) => r.outcome === 'conflict')
  return { oks: oks.length, conflitos: conflitos.length }
}

describe('corridas', () => {
  it('dois assumires simultaneos: um vence, um conflita, um unico evento', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Disputada' })

    const [a, b] = await Promise.all([atribuir(c.maria.db, t, c.maria.userId), atribuir(c.joao.db, t, c.joao.userId)])

    expect(umVence([a, b])).toEqual({ oks: 1, conflitos: 1 })

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.version).toBe(2)
    expect([c.maria.userId, c.joao.userId]).toContain(linha?.assigned_to)

    const assigned = (await eventosDe(c.admin, t.id)).filter((e) => e.event_type === 'assigned')
    expect(assigned).toHaveLength(1)
    // O evento tem de descrever QUEM venceu, nao quem tentou.
    expect((assigned[0]!.metadata as { to: { userId: string } }).to.userId).toBe(
      linha?.assigned_to,
    )
  })

  it('concluir versus mudar prazo: um vence, e nao ha estado hibrido', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Concluir x prazo' })
    const prazo = new Date(Date.now() + 86_400_000).toISOString()

    const [x, y] = await Promise.all([
      concluir(c.maria.db, t),
      definirPrazo(c.joao.db, t, prazo),
    ])

    expect(umVence([x, y])).toEqual({ oks: 1, conflitos: 1 })

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.version).toBe(2)

    // O invariante nao pode ter sido atravessado pelo meio: ou concluiu (e tem
    // carimbo), ou mudou o prazo (e continua aberta sem carimbo).
    if (linha?.status === 'completed') {
      expect(linha.completed_at).not.toBeNull()
      expect(linha.due_at).toBeNull()
    } else {
      expect(linha?.status).toBe('open')
      expect(linha?.completed_at).toBeNull()
      expect(linha?.due_at).not.toBeNull()
    }

    const eventos = (await eventosDe(c.admin, t.id)).filter((e) => e.event_type !== 'created')
    expect(eventos).toHaveLength(1)
  })

  it('duas edicoes simultaneas: uma vence, um unico details_changed', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Texto disputado' })

    const [x, y] = await Promise.all([
      editar(c.maria.db, t, { title: 'Versao da Maria' }),
      editar(c.joao.db, t, { title: 'Versao do Joao' }),
    ])

    expect(umVence([x, y])).toEqual({ oks: 1, conflitos: 1 })
    const alterados = (await eventosDe(c.admin, t.id)).filter(
      (e) => e.event_type === 'details_changed',
    )
    expect(alterados).toHaveLength(1)
  })

  it('reaberturas simultaneas: uma vence, um unico reopened', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Reabrir disputado' })
    const feita = (await concluir(c.maria.db, t)).task!

    const [x, y] = await Promise.all([reabrir(c.maria.db, feita), reabrir(c.joao.db, feita)])

    expect(umVence([x, y])).toEqual({ oks: 1, conflitos: 1 })
    const reopened = (await eventosDe(c.admin, t.id)).filter((e) => e.event_type === 'reopened')
    expect(reopened).toHaveLength(1)
  })

  it('concluir e cancelar ao mesmo tempo: nunca os dois', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Concluir x cancelar' })

    const [x, y] = await Promise.all([concluir(c.maria.db, t), cancelar(c.joao.db, t)])

    expect(umVence([x, y])).toEqual({ oks: 1, conflitos: 1 })
    const linha = await lerTask(c.admin, t.id)
    // O CHECK impede o hibrido, mas provamos o resultado, nao a intencao.
    const carimbos = [linha?.completed_at, linha?.cancelled_at].filter(Boolean)
    expect(carimbos).toHaveLength(1)
  })
})

describe('versao obsoleta', () => {
  it('sempre conflita, e devolve o estado atual para a tela se reconciliar', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Stale' })
    await definirPrazo(c.maria.db, t, new Date(Date.now() + 3_600_000).toISOString())

    const r = await concluir(c.maria.db, t) // ainda com version = 1
    expect(r.outcome).toBe('conflict')
    expect(r.task?.version).toBe(2)
    expect(r.task?.status).toBe('open')
  })

  it('precede a regra de dominio: versao velha em tarefa terminal e conflict', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Precedencia' })
    const comPrazo = (await definirPrazo(c.maria.db, t, new Date(Date.now() + 60_000).toISOString()))
      .task!
    await concluir(c.maria.db, comPrazo)

    // A tarefa esta terminal E a versao esta obsoleta. A resposta tem de ser
    // sobre a versao: quem opera sobre estado velho precisa saber disso ANTES
    // de ser ensinado sobre o estado atual, senao corrige a regra errada.
    const r = await editar(c.maria.db, t, { title: 'Tentativa tardia' })
    expect(r.outcome).toBe('conflict')
  })

  it('conflito nao gera evento nem altera a linha', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Conflito limpo' })
    await atribuir(c.maria.db, t, c.maria.userId)
    const antes = await lerTask(c.admin, t.id)

    const r = await devolver(c.joao.db, t) // versao 1, obsoleta
    expect(r.outcome).toBe('conflict')

    const depois = await lerTask(c.admin, t.id)
    expect(depois?.version).toBe(antes?.version)
    expect(depois?.assigned_to).toBe(antes?.assigned_to)

    const released = (await eventosDe(c.admin, t.id)).filter((e) => e.event_type === 'released')
    expect(released).toHaveLength(0)
  })
})

describe('terminal congelada', () => {
  it('as cinco operacoes operacionais devolvem invalid_state', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Congelada' })
    const feita = (await concluir(c.maria.db, t)).task!

    const resultados = [
      await editar(c.maria.db, feita, { title: 'Outro titulo' }),
      await atribuir(c.maria.db, feita, c.maria.userId),
      await transferir(c.maria.db, feita, c.joao.userId),
      await devolver(c.maria.db, feita),
      await definirPrazo(c.maria.db, feita, new Date(Date.now() + 60_000).toISOString()),
    ]

    for (const r of resultados) {
      expect(r.outcome).toBe('invalid_state')
      expect(r.reason).toBe('terminal')
      expect(r.task?.status).toBe('completed')
    }

    const eventos = (await eventosDe(c.admin, t.id)).map((e) => e.event_type)
    expect(eventos).toEqual(['created', 'completed'])
  })

  it('reabrir e a unica aceita, e depois dela tudo volta', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Descongelar' })
    const feita = (await concluir(c.maria.db, t)).task!
    const reaberta = (await reabrir(c.maria.db, feita)).task!
    expect(reaberta.status).toBe('open')

    const r = await atribuir(c.maria.db, reaberta, c.maria.userId)
    expect(r.outcome).toBe('ok')
    expect(r.task?.assignedTo).toBe(c.maria.userId)
  })

  it('atalhos entre terminais sao recusados sem reabrir', async () => {
    const t1 = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Concluida' })
    const feita = (await concluir(c.maria.db, t1)).task!
    const r1 = await cancelar(c.maria.db, feita)

    const t2 = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Cancelada' })
    const cancelada = (await cancelar(c.maria.db, t2)).task!
    const r2 = await concluir(c.maria.db, cancelada)

    expect(r1.outcome).toBe('invalid_state')
    expect(r1.reason).toBe('invalid_transition')
    expect(r2.outcome).toBe('invalid_state')
    expect(r2.reason).toBe('invalid_transition')
  })
})

describe('semantica de responsavel', () => {
  it('assumir tarefa que ja tem dono nao sobrescreve', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Ja tem dono' })
    const minha = (await atribuir(c.maria.db, t, c.maria.userId)).task!

    const r = await atribuir(c.joao.db, minha, c.joao.userId)
    expect(r.outcome).toBe('invalid_state')
    expect(r.reason).toBe('already_assigned')

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.assigned_to).toBe(c.maria.userId)
  })

  it('transferir sem responsavel atual nao vira assumir implicito', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Sem dono' })
    const r = await transferir(c.maria.db, t, c.joao.userId)
    expect(r.outcome).toBe('invalid_state')
    expect(r.reason).toBe('not_assigned')

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.assigned_to).toBeNull()
  })
})

describe('no-ops', () => {
  const semEvento = async (taskId: string, tipo: string) => {
    const eventos = await eventosDe(c.admin, taskId)
    return eventos.filter((e) => e.event_type === tipo).length
  }

  it('transferir para o mesmo responsavel', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Mesma pessoa' })
    const minha = (await atribuir(c.maria.db, t, c.maria.userId)).task!
    const r = await transferir(c.maria.db, minha, c.maria.userId)
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(minha.version)
    expect(await semEvento(t.id, 'transferred')).toBe(0)
  })

  it('devolver tarefa que ja esta na fila', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Ja na fila' })
    const r = await devolver(c.maria.db, t)
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(1)
    expect(await semEvento(t.id, 'released')).toBe(0)
  })

  it('prazo igual ao atual', async () => {
    const prazo = new Date(Date.now() + 86_400_000).toISOString()
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Prazo igual', dueAt: prazo })
    const r = await definirPrazo(c.maria.db, t, prazo)
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(1)
    expect(await semEvento(t.id, 'due_changed')).toBe(0)
  })

  it('texto identico', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Texto igual' })
    const r = await editar(c.maria.db, t, { title: 'Texto igual' })
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(1)
    expect(await semEvento(t.id, 'details_changed')).toBe(0)
  })

  it('concluir tarefa ja concluida', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Concluir duas vezes' })
    const feita = (await concluir(c.maria.db, t)).task!
    const r = await concluir(c.maria.db, feita)
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(feita.version)
    expect(await semEvento(t.id, 'completed')).toBe(1)
  })

  it('cancelar tarefa ja cancelada', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Cancelar duas vezes' })
    const cancelada = (await cancelar(c.maria.db, t)).task!
    const r = await cancelar(c.maria.db, cancelada)
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(cancelada.version)
    expect(await semEvento(t.id, 'cancelled')).toBe(1)
  })

  it('reabrir tarefa ja aberta', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Reabrir aberta' })
    const r = await reabrir(c.maria.db, t)
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(1)
    expect(await semEvento(t.id, 'reopened')).toBe(0)
  })
})
