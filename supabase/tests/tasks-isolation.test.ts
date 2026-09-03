/**
 * Isolamento entre clinicas em Pendencias, contra o Supabase real.
 *
 * A pergunta que estas asserções respondem nao e "a aplicacao filtra?", e sim
 * "o banco consegue misturar dois tenants se alguem tentar?". Por isso varias
 * delas rodam com a chave ADMINISTRATIVA, que ignora RLS: se a garantia
 * dependesse so de policy, cairia ai.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  UUID_INEXISTENTE,
  atribuir,
  concluir,
  criarTask,
  eventosDe,
  montarCenario,
  novaTask,
  rpc,
  transferir,
  type Cenario,
  registrarLimpeza,
} from './task-helpers'

let c: Cenario

beforeAll(async () => {
  c = await montarCenario()
}, 120_000)

registrarLimpeza(() => c)

describe('leitura', () => {
  it('A nao enxerga as pendencias de B', async () => {
    await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Coisa da clinica B' })
    const { data, error } = await c.maria.db.from('tasks').select('id').eq('clinic_id', c.bruno.clinicId)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('A nao enxerga os eventos de B', async () => {
    const t = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Evento da B' })
    const { data } = await c.maria.db.from('task_events').select('id').eq('task_id', t.id)
    expect(data).toHaveLength(0)
  })

  it('anon nao le nada', async () => {
    await novaTask(c.maria.db, c.maria.clinicId, { title: 'Para o anonimo nao ver' })
    const anon = c.maria.db // mesmo cliente, sem sessao
    const semSessao = await anon.auth.signOut().then(() => anon.from('tasks').select('id'))
    expect(semSessao.data ?? []).toHaveLength(0)
    // Repoe a sessao para os testes seguintes.
    await c.maria.db.auth.signInWithPassword({
      email: c.maria.email,
      password: `Senha-Teste-${c.registry.testRunId}!`,
    })
  })
})

describe('escrita cross-tenant', () => {
  it('criar em clinica alheia devolve not_found, sem vazar estado', async () => {
    const r = await criarTask(c.maria.db, c.bruno.clinicId, { title: 'Tarefa intrusa' })
    expect(r.outcome).toBe('not_found')
    expect(r.task).toBeUndefined()
  })

  it('operar em tarefa alheia devolve not_found, igual a id inexistente', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Da clinica B' })

    const naAlheia = await atribuir(c.maria.db, alheia, c.maria.userId)
    const inexistente = await rpc(c.maria.db, 'task_assign', {
      p_task_id: UUID_INEXISTENTE,
      p_expected_version: 1,
    })

    // Byte a byte iguais: um 403 aqui confirmaria que a tarefa existe.
    expect(naAlheia).toEqual({ outcome: 'not_found' })
    expect(inexistente).toEqual({ outcome: 'not_found' })
  })

  it('transferir para membro de outra clinica devolve not_found', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Transferir para fora' })
    const minha = (await atribuir(c.maria.db, t, c.maria.userId)).task!
    const r = await transferir(c.maria.db, minha, c.bruno.userId)
    expect(r.outcome).toBe('not_found')
  })

  it('nem a chave ADMINISTRATIVA cria vinculo de paciente cross-tenant', async () => {
    // service_role ignora RLS. A FK composta e do catalogo, e nao ignora nada.
    const { error } = await c.admin.from('tasks').insert({
      clinic_id: c.maria.clinicId,
      title: 'Paciente de outra clinica',
      patient_id: c.bruno.patientId,
    })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23503')
  })

  it('nem a chave administrativa atribui a tarefa a membro de outra clinica', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Atribuicao invasiva' })
    const { error } = await c.admin
      .from('tasks')
      .update({ assigned_to: c.bruno.userId })
      .eq('id', t.id)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23503')
  })

  it('nem a chave administrativa cria evento apontando para tarefa de outra clinica', async () => {
    const alheia = await novaTask(c.bruno.db, c.bruno.clinicId, { title: 'Alvo de outra clinica' })
    const { error } = await c.admin.from('task_events').insert({
      clinic_id: c.maria.clinicId,
      task_id: alheia.id,
      event_type: 'completed',
    })
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23503')
  })
})

describe('nao vazamento em conflito', () => {
  it('conflito nao devolve a tarefa depois de a membership acabar', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Ex-membro' })
    await atribuir(c.maria.db, t, c.maria.userId) // versao avanca; a do Joao fica obsoleta

    await c.admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', c.maria.clinicId)
      .eq('user_id', c.joao.userId)

    // Seria `conflict` se ele ainda pertencesse a clinica. Sem vinculo, o
    // estado nao pode vazar por um corpo de 409.
    const r = await concluir(c.joao.db, t)
    expect(r.outcome).toBe('not_found')
    expect(r.task).toBeUndefined()

    await c.admin
      .from('clinic_members')
      .insert({ clinic_id: c.maria.clinicId, user_id: c.joao.userId, role: 'attendant' })
  })

  it('membro da clinica recebe conflito COM o estado atual', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Conflito legitimo' })
    await atribuir(c.maria.db, t, c.maria.userId)
    const r = await concluir(c.joao.db, t)
    expect(r.outcome).toBe('conflict')
    expect(r.task?.version).toBe(2)
  })
})

describe('remocao de membership', () => {
  it('devolve a tarefa a fila sem bloquear, e preserva o historico', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Do Joao' })
    await atribuir(c.joao.db, t, c.joao.userId)

    const { error } = await c.admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', c.maria.clinicId)
      .eq('user_id', c.joao.userId)
    expect(error).toBeNull()

    const { data: linha } = await c.admin
      .from('tasks')
      .select('assigned_to')
      .eq('id', t.id)
      .single()
    expect((linha as { assigned_to: string | null }).assigned_to).toBeNull()

    const assigned = (await eventosDe(c.admin, t.id)).find((e) => e.event_type === 'assigned')!
    expect(assigned.actor_name_snapshot).toBe('Colega JOAO')

    await c.admin
      .from('clinic_members')
      .insert({ clinic_id: c.maria.clinicId, user_id: c.joao.userId, role: 'attendant' })
  })
})
