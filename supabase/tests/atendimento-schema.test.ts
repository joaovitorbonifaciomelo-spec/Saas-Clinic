import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient, loadIsolationEnv, type IsolationEnv } from './helpers'

/**
 * Garantias do BANCO no Atendimento Core v0.1.
 *
 * Estes testes falam com o Postgres, nao com a API — de proposito. Eles rodam
 * ANTES de existir endpoint, porque descobrir um furo de RLS depois de ja ter
 * codigo apoiado nele e caro.
 *
 * Cada bloco prova uma coisa que a aplicacao NAO pode garantir sozinha:
 * FK composta, RLS, trigger de transicao, bump seletivo de versao, carimbo de
 * autoria e a validacao do metadata de agendamento.
 *
 * Projeto proprio (`pnpm test:atendimento`) porque depende das migrations 0012
 * a 0014 estarem aplicadas.
 */

const env: IsolationEnv = loadIsolationEnv()
const admin = createAdminClient(env)
const runId = randomUUID()

interface Tenant {
  email: string
  userId: string
  clinicId: string
  db: SupabaseClient
  patientId: string
  professionalId: string
  conversationId: string
}

const criados = { users: [] as string[], clinics: [] as string[] }

async function montarTenant(rotulo: string): Promise<Tenant> {
  const email = `atend-${rotulo}-${runId}@example.test`
  const password = `Senha-${runId}!`

  const { data: u, error: ue } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Usuario ${rotulo}` },
  })
  if (ue) throw new Error(ue.message)
  criados.users.push(u.user.id)

  const db = createClient(env.url, env.anonKey, { auth: { persistSession: false } })
  const { error: se } = await db.auth.signInWithPassword({ email, password })
  if (se) throw new Error(se.message)

  const { data: clinic, error: ce } = await db
    .rpc('create_clinic_with_owner', { p_name: `Clinica ${rotulo} ${runId.slice(0, 8)}` })
    .single<{ id: string }>()
  if (ce) throw new Error(ce.message)
  criados.clinics.push(clinic!.id)

  const { data: patient } = await db
    .from('patients')
    .insert({ clinic_id: clinic!.id, name: `Paciente ${rotulo}`, phone: '11987650000' })
    .select('id')
    .single()

  const { data: professional } = await db
    .from('professionals')
    .insert({ clinic_id: clinic!.id, name: `Profissional ${rotulo}` })
    .select('id')
    .single()

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .insert({ clinic_id: clinic!.id, channel: 'manual' })
    .select('id')
    .single()
  if (convError) throw new Error(`conversa de ${rotulo}: ${convError.message}`)

  return {
    email,
    userId: u.user.id,
    clinicId: clinic!.id,
    db,
    patientId: patient!.id as string,
    professionalId: professional!.id as string,
    conversationId: conversation!.id as string,
  }
}

let A: Tenant
let B: Tenant

beforeAll(async () => {
  A = await montarTenant('A')
  B = await montarTenant('B')
}, 180_000)

afterAll(async () => {
  if (criados.clinics.length > 0) {
    await admin.from('clinics').delete().in('id', criados.clinics)
  }
  for (const id of criados.users) await admin.auth.admin.deleteUser(id)
}, 120_000)

/* ===========================================================================
   Isolamento entre clinicas — quem responde e o RLS
   ======================================================================== */
describe('isolamento', () => {
  it('A lista somente as conversas de A', async () => {
    const { data } = await A.db.from('conversations').select('id, clinic_id')
    expect(data).not.toBeNull()
    for (const row of data!) expect(row.clinic_id).toBe(A.clinicId)
    expect(data!.map((r) => r.id)).not.toContain(B.conversationId)
  })

  it('A nao enxerga a conversa de B nem por id', async () => {
    const { data } = await A.db.from('conversations').select('*').eq('id', B.conversationId)
    expect(data).toEqual([])
  })

  it('A nao consegue inserir mensagem na conversa de B', async () => {
    const { error } = await A.db.from('messages').insert({
      clinic_id: B.clinicId,
      conversation_id: B.conversationId,
      direction: 'inbound',
      body: 'invasao',
    })
    expect(error).not.toBeNull()
    // 42501 = violacao de policy (WITH CHECK).
    expect(error!.code).toBe('42501')
  })

  it('A nao move a propria conversa para a clinica B', async () => {
    const { error } = await A.db
      .from('conversations')
      .update({ clinic_id: B.clinicId })
      .eq('id', A.conversationId)
    expect(error).not.toBeNull()
  })

  it('UPDATE em conversation_events e negado mesmo para membro', async () => {
    await A.db.from('conversation_events').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      event_type: 'conversation_created',
      metadata: { channel: 'manual' },
    })
    const { data } = await A.db
      .from('conversation_events')
      .update({ event_type: 'assigned' })
      .eq('clinic_id', A.clinicId)
      .select('id')
    // Ausencia de policy de UPDATE: nenhuma linha e alcancada.
    expect(data ?? []).toEqual([])
  })

  it('DELETE em conversas e mensagens nao alcanca nada', async () => {
    const c = await A.db.from('conversations').delete().eq('id', A.conversationId).select('id')
    expect(c.data ?? []).toEqual([])
    const m = await A.db.from('messages').delete().eq('clinic_id', A.clinicId).select('id')
    expect(m.data ?? []).toEqual([])
  })

  it('cliente anonimo nao le nada das tres tabelas', async () => {
    const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } })
    for (const tabela of ['conversations', 'messages', 'conversation_events'] as const) {
      const { data } = await anon.from(tabela).select('id')
      expect(data ?? [], tabela).toEqual([])
    }
  })
})

/* ===========================================================================
   FK composta — o que RLS sozinho NAO garante
   ======================================================================== */
describe('FK tenant-first, inclusive sob service_role', () => {
  it('nem service_role vincula paciente de outra clinica', async () => {
    const { error } = await admin
      .from('conversations')
      .update({ patient_id: B.patientId })
      .eq('id', A.conversationId)
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23503')
  })

  it('nem service_role atribui conversa a membro de outra clinica', async () => {
    const { error } = await admin
      .from('conversations')
      .update({ assigned_to: B.userId })
      .eq('id', A.conversationId)
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23503')
  })

  it('nem service_role cria mensagem apontando para conversa de outra clinica', async () => {
    const { error } = await admin.from('messages').insert({
      clinic_id: A.clinicId,
      conversation_id: B.conversationId,
      direction: 'inbound',
      body: 'cross-tenant',
    })
    expect(error).not.toBeNull()
    // Pode vir do trigger de carimbo de canal (23503) ou da FK composta (23503).
    expect(error!.code).toBe('23503')
  })

  it('atribuir a membro da propria clinica funciona', async () => {
    const { error } = await A.db
      .from('conversations')
      .update({ assigned_to: A.userId })
      .eq('id', A.conversationId)
    expect(error).toBeNull()
  })
})

/* ===========================================================================
   Identidade da thread
   ======================================================================== */
describe('identidade da thread', () => {
  const telefone = () => `+5511${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`

  it('duas conversas manuais SEM telefone coexistem', async () => {
    const a = await A.db.from('conversations').insert({ clinic_id: A.clinicId, channel: 'manual' })
    const b = await A.db.from('conversations').insert({ clinic_id: A.clinicId, channel: 'manual' })
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
  })

  it('duas conversas com o MESMO telefone na mesma clinica colidem', async () => {
    const tel = telefone()
    const a = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual', contact_phone_e164: tel })
    expect(a.error).toBeNull()

    const b = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual', contact_phone_e164: tel })
    expect(b.error).not.toBeNull()
    expect(b.error!.code).toBe('23505')
  })

  it('o mesmo telefone em clinicas diferentes convive', async () => {
    const tel = telefone()
    const a = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual', contact_phone_e164: tel })
    const b = await B.db
      .from('conversations')
      .insert({ clinic_id: B.clinicId, channel: 'manual', contact_phone_e164: tel })
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()
  })

  it('telefone fora de E.164 e recusado', async () => {
    const { error } = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual', contact_phone_e164: '11987654321' })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23514')
  })

  it('canal manual nao aceita provedor', async () => {
    const { error } = await A.db.from('conversations').insert({
      clinic_id: A.clinicId,
      channel: 'manual',
      provider: 'evolution',
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23514')
  })

  it('provider entra no namespace da identidade quando nao ha telefone', async () => {
    const contato = `wa-${runId.slice(0, 8)}`
    // Mesmo texto de provider_contact_id, provedores diferentes: threads
    // diferentes. Um id da Evolution nao e o mesmo id da Meta Cloud.
    const a = await admin.from('conversations').insert({
      clinic_id: A.clinicId,
      channel: 'whatsapp',
      provider: 'evolution',
      provider_contact_id: contato,
    })
    const b = await admin.from('conversations').insert({
      clinic_id: A.clinicId,
      channel: 'whatsapp',
      provider: 'meta_cloud',
      provider_contact_id: contato,
    })
    expect(a.error).toBeNull()
    expect(b.error).toBeNull()

    // Repetir o mesmo par (provider, contato) colide.
    const c = await admin.from('conversations').insert({
      clinic_id: A.clinicId,
      channel: 'whatsapp',
      provider: 'evolution',
      provider_contact_id: contato,
    })
    expect(c.error).not.toBeNull()
    expect(c.error!.code).toBe('23505')
  })
})

/* ===========================================================================
   Transicoes de status
   ======================================================================== */
describe('maquina de estados', () => {
  async function novaConversa(): Promise<string> {
    const { data } = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual' })
      .select('id')
      .single()
    return data!.id as string
  }

  it('permite open -> waiting_patient -> resolved -> open', async () => {
    const id = await novaConversa()
    for (const status of ['waiting_patient', 'resolved', 'open'] as const) {
      const { error } = await A.db.from('conversations').update({ status }).eq('id', id)
      expect(error, status).toBeNull()
    }
  })

  it('recusa resolved -> waiting_patient', async () => {
    const id = await novaConversa()
    await A.db.from('conversations').update({ status: 'resolved' }).eq('id', id)
    const { error } = await A.db
      .from('conversations')
      .update({ status: 'waiting_patient' })
      .eq('id', id)
    expect(error).not.toBeNull()
    expect(error!.message).toContain('INVALID_STATUS_TRANSITION')
  })

  it('nenhum estado e terminal: resolved sempre volta a open', async () => {
    const id = await novaConversa()
    await A.db.from('conversations').update({ status: 'resolved' }).eq('id', id)
    const { error } = await A.db.from('conversations').update({ status: 'open' }).eq('id', id)
    expect(error).toBeNull()
  })

  it('set status = status nao e tratado como transicao', async () => {
    const id = await novaConversa()
    const { error } = await A.db.from('conversations').update({ status: 'open' }).eq('id', id)
    expect(error).toBeNull()
  })
})

/* ===========================================================================
   Mensagens: canal carimbado, atividade e reabertura
   ======================================================================== */
describe('mensagens', () => {
  async function novaConversa(): Promise<string> {
    const { data } = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual' })
      .select('id')
      .single()
    return data!.id as string
  }

  it('o canal e carimbado a partir da conversa, ignorando o que veio', async () => {
    const id = await novaConversa()
    const { data, error } = await A.db
      .from('messages')
      .insert({
        clinic_id: A.clinicId,
        conversation_id: id,
        channel: 'whatsapp', // mentira do cliente
        direction: 'inbound',
        body: 'oi',
      })
      .select('channel')
      .single()
    expect(error).toBeNull()
    expect(data!.channel).toBe('manual')
  })

  it('mensagens manuais identicas podem repetir', async () => {
    const id = await novaConversa()
    const corpo = 'Confirmou por telefone.'
    for (let i = 0; i < 2; i += 1) {
      const { error } = await A.db.from('messages').insert({
        clinic_id: A.clinicId,
        conversation_id: id,
        direction: 'outbound',
        body: corpo,
      })
      expect(error, `insercao ${i}`).toBeNull()
    }
  })

  it('atualiza os timestamps de atividade conforme a direcao', async () => {
    const id = await novaConversa()
    await A.db
      .from('messages')
      .insert({ clinic_id: A.clinicId, conversation_id: id, direction: 'inbound', body: 'oi' })

    const { data } = await A.db
      .from('conversations')
      .select('last_message_at, last_inbound_at, last_outbound_at')
      .eq('id', id)
      .single()

    expect(data!.last_inbound_at).not.toBeNull()
    expect(data!.last_message_at).not.toBeNull()
    expect(data!.last_outbound_at).toBeNull()
  })

  it('mensagem atrasada nao faz a atividade andar para tras', async () => {
    const id = await novaConversa()
    const agora = new Date().toISOString()
    const antes = new Date(Date.now() - 3_600_000).toISOString()

    await A.db.from('messages').insert({
      clinic_id: A.clinicId,
      conversation_id: id,
      direction: 'inbound',
      body: 'recente',
      occurred_at: agora,
    })
    await A.db.from('messages').insert({
      clinic_id: A.clinicId,
      conversation_id: id,
      direction: 'inbound',
      body: 'atrasada',
      occurred_at: antes,
    })

    const { data } = await A.db
      .from('conversations')
      .select('last_message_at')
      .eq('id', id)
      .single()
    expect(new Date(data!.last_message_at as string).getTime()).toBe(new Date(agora).getTime())
  })

  it('mensagem inbound reabre conversa resolvida e registra evento do sistema', async () => {
    const id = await novaConversa()
    await A.db.from('conversations').update({ status: 'resolved' }).eq('id', id)

    await A.db
      .from('messages')
      .insert({ clinic_id: A.clinicId, conversation_id: id, direction: 'inbound', body: 'voltei' })

    const { data: conv } = await A.db
      .from('conversations')
      .select('status')
      .eq('id', id)
      .single()
    expect(conv!.status).toBe('open')

    const { data: eventos } = await A.db
      .from('conversation_events')
      .select('event_type, actor_user_id, metadata')
      .eq('conversation_id', id)
      .eq('event_type', 'status_changed')
    expect(eventos!.length).toBeGreaterThan(0)
    const ev = eventos![eventos!.length - 1]!
    expect(ev.actor_user_id).toBeNull()
    expect((ev.metadata as Record<string, unknown>).reason).toBe('inbound_message')
  })

  it('mensagem outbound NAO reabre conversa resolvida', async () => {
    const id = await novaConversa()
    await A.db.from('conversations').update({ status: 'resolved' }).eq('id', id)
    await A.db
      .from('messages')
      .insert({ clinic_id: A.clinicId, conversation_id: id, direction: 'outbound', body: 'ok' })

    const { data } = await A.db.from('conversations').select('status').eq('id', id).single()
    expect(data!.status).toBe('resolved')
  })
})

/* ===========================================================================
   Concorrencia otimista
   ======================================================================== */
describe('version', () => {
  async function novaConversa(): Promise<{ id: string; version: number }> {
    const { data } = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual' })
      .select('id, version')
      .single()
    return { id: data!.id as string, version: data!.version as number }
  }

  it('muda com operacao de controle', async () => {
    const { id, version } = await novaConversa()
    const { data } = await A.db
      .from('conversations')
      .update({ status: 'resolved' })
      .eq('id', id)
      .select('version')
      .single()
    expect(data!.version).toBe(version + 1)
  })

  it('NAO muda quando chega mensagem', async () => {
    const { id, version } = await novaConversa()
    await A.db
      .from('messages')
      .insert({ clinic_id: A.clinicId, conversation_id: id, direction: 'inbound', body: 'oi' })

    const { data } = await A.db.from('conversations').select('version').eq('id', id).single()
    // Se subisse aqui, a atendente levaria 409 sem nada relevante ter mudado —
    // e a equipe aprenderia a ignorar o aviso de conflito.
    expect(data!.version).toBe(version)
  })

  it('NAO muda em update que nao toca coluna de controle', async () => {
    const { id, version } = await novaConversa()
    await A.db
      .from('conversations')
      .update({ contact_name_snapshot: 'Nome novo' })
      .eq('id', id)
    const { data } = await A.db.from('conversations').select('version').eq('id', id).single()
    expect(data!.version).toBe(version)
  })

  it('update condicional por versao: so um dos dois pega', async () => {
    const { id, version } = await novaConversa()
    const tentar = () =>
      A.db
        .from('conversations')
        .update({ assigned_to: A.userId })
        .eq('id', id)
        .eq('version', version)
        .is('assigned_to', null)
        .select('id')

    const [r1, r2] = await Promise.all([tentar(), tentar()])
    const vencedores = [r1, r2].filter((r) => (r.data ?? []).length === 1)
    expect(vencedores).toHaveLength(1)
  })
})

/* ===========================================================================
   Eventos: autoria e metadata
   ======================================================================== */
describe('conversation_events', () => {
  it('a autoria e carimbada do JWT, ignorando o que o cliente enviar', async () => {
    const { data, error } = await A.db
      .from('conversation_events')
      .insert({
        clinic_id: A.clinicId,
        conversation_id: A.conversationId,
        event_type: 'assigned',
        actor_user_id: B.userId, // mentira do cliente
        actor_name_snapshot: 'Nome Falso',
        metadata: { to_user_id: A.userId },
      })
      .select('actor_user_id, actor_name_snapshot')
      .single()

    expect(error).toBeNull()
    expect(data!.actor_user_id).toBe(A.userId)
    expect(data!.actor_name_snapshot).not.toBe('Nome Falso')
  })

  it('appointment_created exige agendamento da MESMA clinica', async () => {
    const inicio = new Date(Date.now() + 86_400_000).toISOString()
    const fim = new Date(Date.now() + 86_400_000 + 1_800_000).toISOString()

    const { data: apptB } = await B.db
      .from('appointments')
      .insert({
        clinic_id: B.clinicId,
        patient_id: B.patientId,
        professional_id: B.professionalId,
        starts_at: inicio,
        ends_at: fim,
      })
      .select('id')
      .single()

    const { error } = await A.db.from('conversation_events').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      event_type: 'appointment_created',
      metadata: { appointment_id: apptB!.id },
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('APPOINTMENT_NOT_IN_CLINIC')
  })

  it('nem service_role planta agendamento de outra clinica no log', async () => {
    const { data: apptB } = await admin
      .from('appointments')
      .select('id')
      .eq('clinic_id', B.clinicId)
      .limit(1)
      .single()

    const { error } = await admin.from('conversation_events').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      event_type: 'appointment_created',
      metadata: { appointment_id: apptB!.id },
    })
    // jsonb nao recebe FK; a garantia vem do trigger com comparacao explicita
    // de clinic_id, e por isso vale tambem para quem ignora RLS.
    expect(error).not.toBeNull()
    expect(error!.message).toContain('APPOINTMENT_NOT_IN_CLINIC')
  })

  it('appointment_created recusa metadata com chave extra', async () => {
    const { error } = await A.db.from('conversation_events').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      event_type: 'appointment_created',
      metadata: { appointment_id: randomUUID(), payload: { qualquer: 'coisa' } },
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23514')
  })

  it('appointment_created recusa metadata sem appointment_id ou malformado', async () => {
    for (const metadata of [{}, { appointment_id: 'nao-e-uuid' }]) {
      const { error } = await A.db.from('conversation_events').insert({
        clinic_id: A.clinicId,
        conversation_id: A.conversationId,
        event_type: 'appointment_created',
        metadata,
      })
      expect(error, JSON.stringify(metadata)).not.toBeNull()
      expect(error!.code).toBe('23514')
    }
  })

  it('metadata volumoso e recusado', async () => {
    const { error } = await A.db.from('conversation_events').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      event_type: 'status_changed',
      metadata: { payload_bruto: 'x'.repeat(4000) },
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23514')
  })
})

/* ===========================================================================
   Ciclo de vida do membership
   ======================================================================== */
describe('membership removido', () => {
  it('devolve a conversa a fila sem bloquear a remocao, e preserva o historico', async () => {
    const email = `atend-tmp-${runId}@example.test`
    const { data: u } = await admin.auth.admin.createUser({
      email,
      password: `Senha-${runId}!`,
      email_confirm: true,
      user_metadata: { full_name: 'Temporario' },
    })
    criados.users.push(u!.user!.id)

    await admin.from('clinic_members').insert({
      clinic_id: A.clinicId,
      user_id: u!.user!.id,
      role: 'attendant',
    })

    const { data: conv } = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual', assigned_to: u!.user!.id })
      .select('id')
      .single()

    const { error: delErro } = await admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', A.clinicId)
      .eq('user_id', u!.user!.id)
    // A remocao NAO pode ser bloqueada: `set null (assigned_to)` anula so a
    // coluna certa. Sem a lista, o clinic_id (not null) faria isto falhar.
    expect(delErro).toBeNull()

    const { data } = await A.db
      .from('conversations')
      .select('assigned_to')
      .eq('id', conv!.id)
      .single()
    expect(data!.assigned_to).toBeNull()
  })
})

/* ===========================================================================
   Ainda dependem da API (commits 5 a 7)
   ======================================================================== */
describe('nivel HTTP', () => {
  it.todo('404 de conversa de outro tenant e byte a byte igual ao de UUID inexistente')
  it.todo('X-Clinic-Id forjado nao devolve nenhum campo de dado do outro tenant')
  it.todo('dois POST /assign concorrentes devolvem exatamente um 200 e um 409')
  it.todo('409 traz o estado atual completo, com assignedToName')
  it.todo('transfer com responsavel desatualizado devolve 409 sem sobrescrever')
  it.todo('conversa inexistente devolve 404, nao 409, preservando non-disclosure')
  it.todo('telefone descoberto depois, ja existente em outra thread, devolve erro explicado')
})
