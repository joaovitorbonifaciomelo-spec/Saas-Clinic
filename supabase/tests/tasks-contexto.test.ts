/**
 * Contexto e autoria historica, contra o Supabase real.
 *
 * Duas regras que se contradizem a primeira vista convivem aqui, e os testes
 * existem para provar que convivem:
 *
 *   - contexto e IMUTAVEL, inclusive para escrita privilegiada;
 *   - a acao referencial de FK PODE anula-lo, senao apagar um paciente
 *     falharia e a regra de historico viraria trava contra exclusao de dado
 *     pessoal.
 *
 * A separacao entre os dois casos e `pg_trigger_depth()`. Se ela quebrar, um
 * destes dois testes cai — e e por isso que os dois existem lado a lado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAnonClient } from './helpers'
import {
  criarTask,
  lerTask,
  montarCenario,
  novaTask,
  type Cenario,
} from './task-helpers'

let c: Cenario

beforeAll(async () => {
  c = await montarCenario()
}, 120_000)

afterAll(async () => {
  await c?.registry.cleanup(c.admin)
}, 120_000)

async function novaConversa(nome: string): Promise<string> {
  const { data, error } = await c.maria.db.rpc('conversation_create_manual', {
    p_clinic_id: c.maria.clinicId,
    p_contact_phone_e164: null,
    p_contact_name_snapshot: nome,
    p_patient_id: null,
  })
  if (error) throw new Error(`conversa: ${error.message}`)
  return (data as { conversation: { id: string } }).conversation.id
}

async function novoPaciente(nome: string, telefone: string): Promise<string> {
  const { data, error } = await c.admin
    .from('patients')
    .insert({ clinic_id: c.maria.clinicId, name: nome, phone: telefone })
    .select('id')
    .single()
  if (error) throw new Error(`paciente: ${error.message}`)
  return (data as { id: string }).id
}

describe('os tres contextos', () => {
  it('aceita paciente, conversa e agendamento juntos', async () => {
    const conversationId = await novaConversa('Contato de teste')

    const { data: prof } = await c.admin
      .from('professionals')
      .insert({ clinic_id: c.maria.clinicId, name: 'Dra. Ana' })
      .select('id')
      .single()
    const inicio = new Date(Date.now() + 172_800_000)
    const { data: ag, error: erroAg } = await c.admin
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
    if (erroAg) throw new Error(`agendamento: ${erroAg.message}`)
    const appointmentId = (ag as { id: string }).id

    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Com os tres contextos',
      patientId: c.maria.patientId,
      conversationId,
      appointmentId,
    })

    expect(t.patientId).toBe(c.maria.patientId)
    expect(t.conversationId).toBe(conversationId)
    // So possivel porque `appointments` ganhou unique (clinic_id, id): a FK
    // tenant-first precisa desse indice para existir.
    expect(t.appointmentId).toBe(appointmentId)
  })
})

describe('coerencia, so na criacao', () => {
  it('recusa paciente diferente do que a conversa aponta', async () => {
    const conversationId = await novaConversa('Conversa vinculada')
    await c.maria.db.rpc('conversation_link_patient', {
      p_conversation_id: conversationId,
      p_expected_version: 1,
      p_patient_id: c.maria.patientId,
    })
    const outro = await novoPaciente('Outro Paciente', '11955554444')

    const r = await criarTask(c.maria.db, c.maria.clinicId, {
      title: 'Incoerente',
      conversationId,
      patientId: outro,
    })
    expect(r.outcome).toBe('patient_mismatch')
    expect(r.task).toBeUndefined()
  })

  it('conversa sem paciente aceita qualquer paciente', async () => {
    const conversationId = await novaConversa('Conversa solta')
    const r = await criarTask(c.maria.db, c.maria.clinicId, {
      title: 'Coerente',
      conversationId,
      patientId: c.maria.patientId,
    })
    expect(r.outcome).toBe('ok')
  })

  it('NAO e reverificada depois: desvincular a conversa continua possivel', async () => {
    const conversationId = await novaConversa('Vai desvincular')
    await c.maria.db.rpc('conversation_link_patient', {
      p_conversation_id: conversationId,
      p_expected_version: 1,
      p_patient_id: c.maria.patientId,
    })
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Sobrevive ao desvinculo',
      conversationId,
      patientId: c.maria.patientId,
    })

    const { data } = await c.maria.db.rpc('conversation_unlink_patient', {
      p_conversation_id: conversationId,
      p_expected_version: 2,
    })

    // Uma constraint continua faria o Atendimento virar refem de Pendencias:
    // ninguem conseguiria desvincular um paciente enquanto houvesse pendencia.
    expect((data as { outcome: string }).outcome).toBe('ok')

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.patient_id).toBe(c.maria.patientId)
  })
})

describe('imutabilidade x acao referencial', () => {
  it('trocar o paciente por escrita privilegiada e recusado', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Contexto fixo',
      patientId: c.maria.patientId,
    })
    const outro = await novoPaciente('Paciente Trocado', '11933332222')

    const { error } = await c.admin
      .from('tasks')
      .update({ patient_id: outro })
      .eq('id', t.id)

    expect(error?.message ?? '').toContain('CONTEXT_IMMUTABLE')
    expect((await lerTask(c.admin, t.id))?.patient_id).toBe(c.maria.patientId)
  })

  it('ZERAR o contexto por escrita privilegiada tambem e recusado', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Zerar na marra',
      patientId: c.maria.patientId,
    })

    const { error } = await c.admin.from('tasks').update({ patient_id: null }).eq('id', t.id)

    // A excecao de `valor -> nulo` vale SO para a acao referencial. Sem essa
    // distincao, qualquer UPDATE privilegiado zeraria contextos parecendo FK.
    expect(error?.message ?? '').toContain('CONTEXT_IMMUTABLE')
    expect((await lerTask(c.admin, t.id))?.patient_id).toBe(c.maria.patientId)
  })

  it('apagar o paciente NAO bloqueia, zera o vinculo e preserva a pendencia', async () => {
    const efemero = await novoPaciente('Paciente Efemero', '11922221111')
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Do paciente efemero',
      patientId: efemero,
    })

    // Mesmo caminho do teste anterior, resultado oposto: aqui quem anula e a
    // FK, e a regra de historico nao pode virar trava contra apagar dado
    // pessoal que o administrador decidiu apagar.
    const { error } = await c.admin.from('patients').delete().eq('id', efemero)
    expect(error).toBeNull()

    const linha = await lerTask(c.admin, t.id)
    expect(linha).not.toBeNull()
    expect(linha?.patient_id).toBeNull()
    expect(linha?.status).toBe('open')
    // Ninguem editou a pendencia: anular por FK nao gasta versao, e por isso
    // nenhuma tela aberta leva 409 por causa da exclusao de um paciente.
    expect(linha?.version).toBe(1)
  })
})

describe('autoria historica', () => {
  it('apagar a conta de quem concluiu nao viola CHECK nem bloqueia', async () => {
    const email = `saiu-${c.registry.testRunId}@example.test`
    const password = `Senha-Teste-${c.registry.testRunId}!`

    const { data: criado, error: erroCriar } = await c.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Quem Concluiu', test_run_id: c.registry.testRunId },
    })
    if (erroCriar || !criado.user) throw new Error(`criar: ${erroCriar?.message}`)
    const efemero = criado.user.id
    c.registry.registerUser(efemero)

    await c.admin
      .from('clinic_members')
      .insert({ clinic_id: c.maria.clinicId, user_id: efemero, role: 'attendant' })

    const sessao: SupabaseClient = createAnonClient(c.env)
    await sessao.auth.signInWithPassword({ email, password })

    const t = await novaTask(sessao, c.maria.clinicId, { title: 'Concluida por quem sai' })
    await sessao.rpc('task_complete', { p_task_id: t.id, p_expected_version: t.version })

    /*
     * O TESTE. Se o CHECK dissesse "concluida => completed_by not null", este
     * delete dispararia o SET NULL, violaria a constraint e FALHARIA — e a
     * auditoria teria virado uma trava contra remover uma pessoa.
     */
    const { error } = await c.admin.auth.admin.deleteUser(efemero)
    expect(error).toBeNull()

    const linha = await lerTask(c.admin, t.id)
    expect(linha?.status).toBe('completed')
    expect(linha?.completed_at).not.toBeNull()
    expect(linha?.completed_by).toBeNull()

    const { data: eventos } = await c.admin
      .from('task_events')
      .select('actor_user_id, actor_name_snapshot, actor_role_snapshot')
      .eq('task_id', t.id)
      .eq('event_type', 'completed')

    const ev = (
      eventos as {
        actor_user_id: string | null
        actor_name_snapshot: string | null
        actor_role_snapshot: string | null
      }[]
    )[0]!

    expect(ev.actor_user_id).toBeNull()
    // Nome e papel sobrevivem no snapshot: e exatamente para isso que ele existe.
    expect(ev.actor_name_snapshot).toBe('Quem Concluiu')
    expect(ev.actor_role_snapshot).toBe('attendant')
  })
})
