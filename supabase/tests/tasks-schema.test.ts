/**
 * Invariantes de `tasks` contra o Supabase real.
 *
 * O PGlite ja provou que a cadeia parseia e que as regras se comportam. Aqui a
 * pergunta e outra: o Supabase — com PostgREST, servidor de auth e a
 * reconciliacao de privilegios da plataforma no meio — se comporta igual?
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  cancelar,
  concluir,
  criarTask,
  editar,
  lerTask,
  montarCenario,
  novaTask,
  reabrir,
  type Cenario,
  registrarLimpeza,
} from './task-helpers'

let c: Cenario

beforeAll(async () => {
  c = await montarCenario()
}, 120_000)

registrarLimpeza(() => c)

describe('criacao', () => {
  it('aceita pendencia geral, sem contexto nenhum', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Revisar encaixes de amanha',
    })
    expect(t.patientId).toBeNull()
    expect(t.conversationId).toBeNull()
    expect(t.appointmentId).toBeNull()
    expect(t.status).toBe('open')
    expect(t.version).toBe(1)
    expect(t.createdBy).toBe(c.maria.userId)
  })

  it('aceita contexto de paciente', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Cobrar documento',
      patientId: c.maria.patientId,
    })
    expect(t.patientId).toBe(c.maria.patientId)
  })

  it('carimba created_by a partir do JWT, nao do cliente', async () => {
    const t = await novaTask(c.joao.db, c.maria.clinicId, { title: 'Criada pelo Joao' })
    expect(t.createdBy).toBe(c.joao.userId)
  })

  it('nasce sem responsavel e sem prazo por padrao', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Fila geral' })
    expect(t.assignedTo).toBeNull()
    expect(t.dueAt).toBeNull()
  })

  it('aceita nascer com responsavel e prazo', async () => {
    const prazo = new Date(Date.now() + 86_400_000).toISOString()
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Nasce completa',
      assignee: c.joao.userId,
      dueAt: prazo,
    })
    expect(t.assignedTo).toBe(c.joao.userId)
    expect(t.dueAt).not.toBeNull()
  })

  it('recusa responsavel que nao e membro da clinica', async () => {
    const r = await criarTask(c.maria.db, c.maria.clinicId, {
      title: 'Responsavel de fora',
      assignee: c.bruno.userId,
    })
    expect(r.outcome).toBe('not_found')
    expect(r.task).toBeUndefined()
  })

  it('recusa titulo curto e titulo longo demais', async () => {
    await expect(criarTask(c.maria.db, c.maria.clinicId, { title: 'ab' })).rejects.toThrow()
    await expect(
      criarTask(c.maria.db, c.maria.clinicId, { title: 'a'.repeat(201) }),
    ).rejects.toThrow()
  })

  it('normaliza descricao em branco para null', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Descricao vazia',
      description: '    ',
    })
    expect(t.description).toBeNull()
  })
})

describe('invariantes de estado', () => {
  it('open nao carrega carimbo de conclusao nem de cancelamento', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Aberta limpa' })
    const linha = await lerTask(c.admin, t.id)
    expect(linha?.completed_at).toBeNull()
    expect(linha?.completed_by).toBeNull()
    expect(linha?.cancelled_at).toBeNull()
    expect(linha?.cancelled_by).toBeNull()
  })

  it('completed carimba instante e autor, e zera o lado do cancelamento', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Concluir' })
    const r = await concluir(c.maria.db, t)
    expect(r.outcome).toBe('ok')
    expect(r.task?.completedAt).not.toBeNull()
    expect(r.task?.completedBy).toBe(c.maria.userId)
    expect(r.task?.cancelledAt).toBeNull()
    expect(r.task?.cancelledBy).toBeNull()
  })

  it('cancelled carimba instante e autor, e zera o lado da conclusao', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Cancelar' })
    const r = await cancelar(c.maria.db, t)
    expect(r.outcome).toBe('ok')
    expect(r.task?.cancelledAt).not.toBeNull()
    expect(r.task?.cancelledBy).toBe(c.maria.userId)
    expect(r.task?.completedAt).toBeNull()
  })

  it('reabrir limpa os dois lados', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Reabrir' })
    const feita = (await concluir(c.maria.db, t)).task!
    const r = await reabrir(c.maria.db, feita)
    expect(r.task?.status).toBe('open')
    expect(r.task?.completedAt).toBeNull()
    expect(r.task?.completedBy).toBeNull()
    expect(r.task?.cancelledAt).toBeNull()
    expect(r.task?.cancelledBy).toBeNull()
  })

  it('escrita direta em tasks e negada a authenticated', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Nao mexa' })

    const insert = await c.maria.db.from('tasks').insert({
      clinic_id: c.maria.clinicId,
      title: 'Insercao direta',
    })
    const update = await c.maria.db.from('tasks').update({ title: 'mexido' }).eq('id', t.id)
    const del = await c.maria.db.from('tasks').delete().eq('id', t.id)

    // Sem grant e sem policy: as tres tem de falhar, e a linha continua intacta.
    expect(insert.error).not.toBeNull()
    expect(update.error).not.toBeNull()
    expect(del.error).not.toBeNull()

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.title).toBe('Nao mexa')
  })
})

describe('versao', () => {
  it('bump acontece em mudanca real', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Titulo original' })
    const r = await editar(c.maria.db, t, { title: 'Titulo novo' })
    expect(r.task?.version).toBe(2)
  })

  it('no-op nao gasta versao', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Mesmo titulo' })
    const r = await editar(c.maria.db, t, { title: 'Mesmo titulo' })
    expect(r.outcome).toBe('ok')
    expect(r.task?.version).toBe(1)
  })

  it('setar descricao exige o flag: sem ele, null nao apaga', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Com descricao',
      description: 'instrucao operacional',
    })
    const semFlag = await editar(c.maria.db, t, { title: 'Outro titulo' })
    expect(semFlag.task?.description).toBe('instrucao operacional')

    const comFlag = await editar(c.maria.db, semFlag.task!, {
      description: null,
      setDescription: true,
    })
    expect(comFlag.task?.description).toBeNull()
  })
})
