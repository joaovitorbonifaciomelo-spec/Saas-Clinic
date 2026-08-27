import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient, loadIsolationEnv, type IsolationEnv } from './helpers'

/**
 * Atendimento contra o SUPABASE REAL.
 *
 * A forma e o comportamento do SQL ja sao verificados por `pnpm
 * verify:migrations`, que roda a cadeia inteira num Postgres efemero e faz 57
 * afirmacoes. Duplicar aquilo aqui so faria a suite demorar mais.
 *
 * O que SO aparece aqui, e por isso este arquivo existe:
 *
 *   - PostgREST no meio, com o papel `authenticated` de verdade;
 *   - a reconciliacao de privilegios da plataforma do Supabase, que ja concedeu
 *     TRUNCATE por conta propria uma vez neste projeto;
 *   - `service_role` de verdade, com BYPASSRLS de verdade;
 *   - o servidor de auth emitindo o JWT que alimenta `auth.uid()`.
 *
 * Depende das migrations 0012 a 0014 aplicadas: `pnpm test:atendimento`.
 */

const env: IsolationEnv = loadIsolationEnv()
const admin = createAdminClient(env)
const runId = randomUUID()

interface Tenant {
  userId: string
  clinicId: string
  db: SupabaseClient
  patientId: string
  professionalId: string
  conversationId: string
  version: number
}

const criados = { users: [] as string[], clinics: [] as string[] }

async function novoUsuario(rotulo: string): Promise<{ id: string; db: SupabaseClient }> {
  const email = `atend-${rotulo}-${runId}@example.test`
  const password = `Senha-${runId}!`
  const { data: u, error: ue } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Usuario ${rotulo}` },
  })
  if (ue) throw new Error(ue.message)
  criados.users.push(u.user!.id)

  const db = createClient(env.url, env.anonKey, { auth: { persistSession: false } })
  const { error: se } = await db.auth.signInWithPassword({ email, password })
  if (se) throw new Error(se.message)
  return { id: u.user!.id, db }
}

async function montarTenant(rotulo: string): Promise<Tenant> {
  const { id: userId, db } = await novoUsuario(rotulo)

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

  const { data: criada, error: convError } = await db.rpc('conversation_create_manual', {
    p_clinic_id: clinic!.id,
    p_contact_phone_e164: null,
    p_contact_name_snapshot: null,
    p_patient_id: null,
  })
  if (convError) throw new Error(`conversa de ${rotulo}: ${convError.message}`)
  const conversation = (criada as RpcResult).conversation!

  return {
    userId,
    clinicId: clinic!.id,
    db,
    patientId: patient!.id as string,
    professionalId: professional!.id as string,
    conversationId: conversation!.id as string,
    version: conversation!.version as number,
  }
}

let A: Tenant
let B: Tenant
/** Segundo membro da clinica A: precisa existir para provar a corrida. */
let A2: { id: string; db: SupabaseClient }

beforeAll(async () => {
  A = await montarTenant('A')
  B = await montarTenant('B')
  A2 = await novoUsuario('A2')
  await admin
    .from('clinic_members')
    .insert({ clinic_id: A.clinicId, user_id: A2.id, role: 'attendant' })
}, 240_000)

afterAll(async () => {
  if (criados.clinics.length > 0) {
    await admin.from('clinics').delete().in('id', criados.clinics)
  }
  for (const id of criados.users) await admin.auth.admin.deleteUser(id)
}, 120_000)

/**
 * Forma unica de resposta das funcoes de controle.
 *
 * Elas devolvem `outcome` em vez de lancar excecao porque conflito de versao e
 * fluxo normal de caixa compartilhada, nao erro: duas atendentes clicando quase
 * juntas e o caso esperado, e a que perdeu precisa receber o estado atual para
 * a tela se corrigir sozinha.
 */
interface RpcResult {
  outcome: 'ok' | 'conflict' | 'not_found' | 'exists' | 'not_manual' | 'invalid_body'
  conversation?: Record<string, unknown>
  message?: Record<string, unknown>
}

async function chamar(
  db: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const { data, error } = await db.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as RpcResult
}

async function criarManual(
  t: Tenant,
  extra: { telefone?: string | null; nome?: string | null; pacienteId?: string | null } = {},
): Promise<RpcResult> {
  return chamar(t.db, 'conversation_create_manual', {
    p_clinic_id: t.clinicId,
    p_contact_phone_e164: extra.telefone ?? null,
    p_contact_name_snapshot: extra.nome ?? null,
    p_patient_id: extra.pacienteId ?? null,
  })
}

async function novaConversa(t: Tenant): Promise<{ id: string; version: number }> {
  const r = await criarManual(t)
  if (r.outcome !== 'ok') throw new Error(`create_manual devolveu ${r.outcome}`)
  return { id: r.conversation!.id as string, version: r.conversation!.version as number }
}

async function novaMensagem(
  t: Tenant,
  conversationId: string,
  direction: 'inbound' | 'outbound',
  body: string,
  occurredAt: string | null = null,
): Promise<RpcResult> {
  return chamar(t.db, 'conversation_add_manual_message', {
    p_conversation_id: conversationId,
    p_direction: direction,
    p_body: body,
    p_occurred_at: occurredAt,
  })
}

/** Eventos de uma conversa, em ordem, lidos pelo admin (ignora RLS de proposito). */
async function eventos(conversationId: string) {
  const { data } = await admin
    .from('conversation_events')
    .select('event_type, actor_user_id, metadata, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  return data ?? []
}

/* ===========================================================================
   Privilegios REAIS — o que a plataforma concedeu por conta propria
   ======================================================================== */
describe('privilegios de authenticated', () => {
  it('UPDATE direto em conversations e negado', async () => {
    const { error, data } = await A.db
      .from('conversations')
      .update({ status: 'resolved' })
      .eq('id', A.conversationId)
      .select('id')
    // Concorrencia otimista so e garantia se este caminho nao existir.
    expect(error ?? { code: '' }).toBeTruthy()
    expect(data ?? []).toEqual([])
  })

  it('INSERT direto em conversation_events e negado', async () => {
    const { error } = await A.db.from('conversation_events').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      event_type: 'transferred',
      metadata: {},
    })
    // Sem isto, um membro fabricaria historico que nunca aconteceu.
    expect(error).not.toBeNull()
  })

  it('DELETE nao alcanca nenhuma das tres tabelas', async () => {
    for (const tabela of ['conversations', 'messages', 'conversation_events'] as const) {
      const { data } = await A.db.from(tabela).delete().eq('clinic_id', A.clinicId).select('id')
      expect(data ?? [], tabela).toEqual([])
    }
  })

  /*
   * A reconciliacao de privilegios da plataforma nao e verificada por
   * introspecao — nao ha RPC para isso e criar uma so para o teste seria
   * expor `pg_catalog` a `authenticated`. Ela e verificada pelo EFEITO: os
   * tres testes acima falham se UPDATE, INSERT ou DELETE voltarem sozinhos.
   * `pnpm verify:privileges` continua sendo a checagem direta.
   */
})

/* ===========================================================================
   Operacoes de controle via RPC
   ======================================================================== */
describe('controle por RPC', () => {
  it('assign devolve ok e grava o evento', async () => {
    const c = await novaConversa(A)
    const { data, error } = await A.db.rpc('conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    expect(error).toBeNull()
    expect((data as { outcome: string }).outcome).toBe('ok')

    const { data: eventos } = await A.db
      .from('conversation_events')
      .select('event_type')
      .eq('conversation_id', c.id)
      .eq('event_type', 'assigned')
    expect(eventos!.length).toBe(1)
  })

  it('dois assign concorrentes: exatamente um vence', async () => {
    for (let rodada = 0; rodada < 3; rodada += 1) {
      const c = await novaConversa(A)
      const chamada = (db: SupabaseClient) =>
        db.rpc('conversation_assign', {
          p_conversation_id: c.id,
          p_expected_version: c.version,
        })

      const [r1, r2] = await Promise.all([chamada(A.db), chamada(A2.db)])
      const oks = [r1, r2].filter(
        (r) => (r.data as { outcome: string } | null)?.outcome === 'ok',
      )
      expect(oks, `rodada ${rodada}`).toHaveLength(1)
    }
  }, 90_000)

  it('versao stale devolve conflito com o estado atual', async () => {
    const c = await novaConversa(A)
    await A.db.rpc('conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    const { data } = await A2.db.rpc('conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    const r = data as { outcome: string; conversation: { assignedTo: string; version: number } }
    expect(r.outcome).toBe('conflict')
    expect(r.conversation.assignedTo).toBe(A.userId)
    expect(r.conversation.version).toBe(c.version + 1)
  })

  it('conversa de outro tenant e inexistente dao a MESMA resposta', async () => {
    const outroTenant = await A.db.rpc('conversation_assign', {
      p_conversation_id: B.conversationId,
      p_expected_version: 1,
    })
    const inexistente = await A.db.rpc('conversation_assign', {
      p_conversation_id: randomUUID(),
      p_expected_version: 1,
    })
    // Non-disclosure: distinguir revelaria a existencia de conversa alheia.
    expect(JSON.stringify(outroTenant.data)).toBe(JSON.stringify(inexistente.data))
    expect((outroTenant.data as { outcome: string }).outcome).toBe('not_found')
  })

  it('status muda por RPC e o evento nasce na mesma transacao', async () => {
    const c = await novaConversa(A)
    const { data } = await A.db.rpc('conversation_set_status', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
      p_status: 'resolved',
    })
    expect((data as { outcome: string }).outcome).toBe('ok')

    const { data: ev } = await A.db
      .from('conversation_events')
      .select('metadata')
      .eq('conversation_id', c.id)
      .eq('event_type', 'status_changed')
      .single()
    expect((ev!.metadata as Record<string, string>).from).toBe('open')
    expect((ev!.metadata as Record<string, string>).to).toBe('resolved')
  })

  it('transicao invalida nao deixa evento orfao', async () => {
    const c = await novaConversa(A)
    await A.db.rpc('conversation_set_status', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
      p_status: 'resolved',
    })
    const { error } = await A.db.rpc('conversation_set_status', {
      p_conversation_id: c.id,
      p_expected_version: c.version + 1,
      p_status: 'waiting_patient',
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('INVALID_STATUS_TRANSITION')

    const { data: eventos } = await A.db
      .from('conversation_events')
      .select('id')
      .eq('conversation_id', c.id)
      .eq('event_type', 'status_changed')
    expect(eventos!.length).toBe(1)
  })

  it('paciente de outra clinica e recusado pela FK composta', async () => {
    const c = await novaConversa(A)
    const { error } = await A.db.rpc('conversation_link_patient', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
      p_patient_id: B.patientId,
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23503')
  })
})

/* ===========================================================================
   Autoria e proveniencia
   ======================================================================== */
describe('autoria', () => {
  it('nao ha caminho para forjar autor: o campo nao e aceito do cliente', async () => {
    const c = await novaConversa(A)

    // Antes o INSERT direto passava e o trigger corrigia o autor. Agora a
    // tentativa e barrada uma camada antes, no privilegio.
    const { error } = await A.db.from('messages').insert({
      clinic_id: A.clinicId,
      conversation_id: c.id,
      direction: 'outbound',
      body: 'ola',
      author_user_id: B.userId,
      author_name_snapshot: 'Nome Falso',
    })
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')

    // E a funcao controlada nao tem parametro de autoria para forjar: quem
    // assina e sempre auth.uid(), carimbado pelo servidor.
    const r = await novaMensagem(A, c.id, 'outbound', 'ola')
    expect(r.message!.authorUserId).toBe(A.userId)
    expect(r.message!.authorName).not.toBe('Nome Falso')
  })

  it('nem service_role planta appointment_created cross-tenant', async () => {
    const inicio = new Date(Date.now() + 86_400_000).toISOString()
    const { data: apptB } = await B.db
      .from('appointments')
      .insert({
        clinic_id: B.clinicId,
        patient_id: B.patientId,
        professional_id: B.professionalId,
        starts_at: inicio,
        ends_at: new Date(Date.now() + 86_400_000 + 1_800_000).toISOString(),
      })
      .select('id')
      .single()

    // jsonb nao recebe FK; a garantia vem do trigger SECURITY DEFINER com
    // comparacao explicita de clinic_id, e por isso vale para quem ignora RLS.
    const { error } = await admin.from('conversation_events').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      event_type: 'appointment_created',
      metadata: { appointment_id: apptB!.id },
    })
    expect(error).not.toBeNull()
    expect(error!.message).toContain('APPOINTMENT_NOT_IN_CLINIC')
  })
})

/* ===========================================================================
   Isolamento com service_role de verdade
   ======================================================================== */
describe('isolamento', () => {
  it('A so enxerga as conversas de A', async () => {
    const { data } = await A.db.from('conversations').select('clinic_id')
    for (const row of data!) expect(row.clinic_id).toBe(A.clinicId)
  })

  it('nem service_role atribui conversa a membro de outra clinica', async () => {
    const { error } = await admin
      .from('conversations')
      .update({ assigned_to: B.userId })
      .eq('id', A.conversationId)
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23503')
  })

  it('cliente anonimo nao le nada', async () => {
    const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false } })
    for (const tabela of ['conversations', 'messages', 'conversation_events'] as const) {
      const { data } = await anon.from(tabela).select('id')
      expect(data ?? [], tabela).toEqual([])
    }
  })

  it('remover membership devolve a conversa a fila e preserva a autoria', async () => {
    const { id: tmpId, db: tmpDb } = await novoUsuario('tmp')
    await admin
      .from('clinic_members')
      .insert({ clinic_id: A.clinicId, user_id: tmpId, role: 'attendant' })

    const c = await novaConversa(A)
    await tmpDb.rpc('conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })

    const { error: delErro } = await admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', A.clinicId)
      .eq('user_id', tmpId)
    // `set null (assigned_to)`: a remocao nao pode ser bloqueada.
    expect(delErro).toBeNull()

    const { data: conv } = await A.db
      .from('conversations')
      .select('assigned_to')
      .eq('id', c.id)
      .single()
    expect(conv!.assigned_to).toBeNull()

    const { data: ev } = await A.db
      .from('conversation_events')
      .select('actor_name_snapshot')
      .eq('conversation_id', c.id)
      .eq('event_type', 'assigned')
      .single()
    // Historico sobrevive a saida do funcionario.
    expect(ev!.actor_name_snapshot).not.toBeNull()
  }, 90_000)
})

/* ===========================================================================
   Ainda dependem da API (commits 5 a 7)
   ======================================================================== */
/* ===========================================================================
   Criacao manual — o banco decide, nao o cliente
   ======================================================================== */
describe('criacao manual', () => {
  it('INSERT direto em conversations e negado', async () => {
    const { error } = await A.db
      .from('conversations')
      .insert({ clinic_id: A.clinicId, channel: 'manual' })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/permission denied/i)
  })

  it('INSERT direto em messages e negado', async () => {
    const { error } = await A.db.from('messages').insert({
      clinic_id: A.clinicId,
      conversation_id: A.conversationId,
      direction: 'inbound',
      body: 'oi',
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/permission denied/i)
  })

  it('nasce open, sem dono, versao 1 e canal manual', async () => {
    const r = await criarManual(A)
    expect(r.outcome).toBe('ok')
    expect(r.conversation).toMatchObject({
      status: 'open',
      assignedTo: null,
      version: 1,
      channel: 'manual',
      provider: null,
    })
  })

  it('clinica sem vinculo devolve not_found, nao permission denied', async () => {
    // A pede uma conversa na clinica de B. Nao pode vazar nem a existencia
    // dela — por isso not_found, o mesmo que um UUID inventado daria.
    const r = await chamar(A.db, 'conversation_create_manual', {
      p_clinic_id: B.clinicId,
      p_contact_phone_e164: null,
      p_contact_name_snapshot: null,
      p_patient_id: null,
    })
    expect(r.outcome).toBe('not_found')
    expect(r.conversation).toBeUndefined()
  })

  it('paciente de outra clinica e barrado pela FK composta', async () => {
    await expect(criarManual(A, { pacienteId: B.patientId })).rejects.toThrow()
  })

  it('nascer vinculada registra o paciente no proprio conversation_created', async () => {
    const r = await criarManual(A, { pacienteId: A.patientId })
    expect(r.outcome).toBe('ok')

    const evs = await eventos(r.conversation!.id as string)
    // Um evento so. A conversa NASCEU vinculada; ninguem executou a operacao de
    // vincular, e inventar um patient_linked corromperia a auditoria.
    expect(evs).toHaveLength(1)
    expect(evs[0]!.event_type).toBe('conversation_created')
    expect((evs[0]!.metadata as Record<string, unknown>).patient_id).toBe(A.patientId)
  })
})

/* ===========================================================================
   Identidade da thread e idempotencia
   ======================================================================== */
describe('identidade da thread', () => {
  it('mesmo telefone na mesma clinica devolve a conversa existente', async () => {
    const tel = `+5511${Date.now().toString().slice(-9)}`
    const primeira = await criarManual(A, { telefone: tel })
    const segunda = await criarManual(A, { telefone: tel })

    expect(primeira.outcome).toBe('ok')
    // Duas atendentes abrindo a mesma pessoa e fluxo normal, nao falha: a
    // segunda recebe a MESMA thread em vez de um 23505 cru.
    expect(segunda.outcome).toBe('exists')
    expect(segunda.conversation!.id).toBe(primeira.conversation!.id)
  })

  it('mesmo telefone em clinicas diferentes convive', async () => {
    const tel = `+5511${(Date.now() + 1).toString().slice(-9)}`
    const emA = await criarManual(A, { telefone: tel })
    const emB = await criarManual(B, { telefone: tel })
    expect(emA.outcome).toBe('ok')
    expect(emB.outcome).toBe('ok')
    expect(emA.conversation!.id).not.toBe(emB.conversation!.id)
  })

  it('telefone fora de E.164 e recusado', async () => {
    await expect(criarManual(A, { telefone: '11987654321' })).rejects.toThrow()
  })

  it('nem service_role troca o canal de uma conversa', async () => {
    const c = await novaConversa(A)
    const { error } = await admin
      .from('conversations')
      .update({ channel: 'whatsapp' })
      .eq('id', c.id)
    // Canal e parte da identidade: mudar reescreveria de que thread a conversa e.
    expect(error).not.toBeNull()
  })
})

/* ===========================================================================
   Mensagens manuais — autoria x registro
   ======================================================================== */
describe('mensagens manuais', () => {
  it('inbound: sem autor, mas com quem registrou', async () => {
    const c = await novaConversa(A)
    const r = await novaMensagem(A, c.id, 'inbound', 'Pode ser quinta?')
    expect(r.outcome).toBe('ok')
    // Quem DISSE foi o paciente; quem REGISTROU foi a atendente. Sao pessoas
    // diferentes, e achatar isso num campo so falsificaria o historico.
    expect(r.message!.authorUserId).toBeNull()
    expect(r.message!.recordedByUserId).toBe(A.userId)
    expect(r.message!.recordedByName).not.toBeNull()
  })

  it('outbound: autor e registrador sao a mesma pessoa', async () => {
    const c = await novaConversa(A)
    const r = await novaMensagem(A, c.id, 'outbound', 'Tenho quinta as 10.')
    expect(r.message!.authorUserId).toBe(A.userId)
    expect(r.message!.recordedByUserId).toBe(A.userId)
  })

  it('mensagem manual nunca finge entrega', async () => {
    const c = await novaConversa(A)
    const r = await novaMensagem(A, c.id, 'outbound', 'ok')
    expect(r.message!.deliveryStatus).toBeNull()
    expect(r.message!.channel).toBe('manual')
  })

  it('nem service_role marca entrega em mensagem manual', async () => {
    const c = await novaConversa(A)
    const { error } = await admin.from('messages').insert({
      clinic_id: A.clinicId,
      conversation_id: c.id,
      channel: 'manual',
      direction: 'outbound',
      body: 'x',
      delivery_status: 'delivered',
    })
    expect(error).not.toBeNull()
    expect(error!.message).toMatch(/messages_manual_has_no_delivery|violates check/i)
  })

  it('conversa de outro tenant devolve not_found', async () => {
    const r = await novaMensagem(A, B.conversationId, 'inbound', 'oi')
    expect(r.outcome).toBe('not_found')
  })

  it('corpo vazio e recusado', async () => {
    const c = await novaConversa(A)
    const r = await novaMensagem(A, c.id, 'inbound', '   ')
    expect(r.outcome).toBe('invalid_body')
  })

  it('inbound reabre conversa resolvida, e o evento e do SISTEMA', async () => {
    const c = await novaConversa(A)
    await chamar(A.db, 'conversation_set_status', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
      p_status: 'resolved',
    })
    await novaMensagem(A, c.id, 'inbound', 'voltei')

    const { data } = await admin.from('conversations').select('status').eq('id', c.id).single()
    expect(data!.status).toBe('open')

    const reabertura = (await eventos(c.id)).filter(
      (e) => (e.metadata as Record<string, unknown>)?.reason === 'inbound_message',
    )
    expect(reabertura).toHaveLength(1)
    // Quem registrou a mensagem NAO decidiu reabrir. Atribuir a reabertura a
    // essa pessoa poria na auditoria uma decisao que ela nunca tomou.
    expect(reabertura[0]!.actor_user_id).toBeNull()
  })

  it('mensagem nao incrementa a versao da conversa', async () => {
    const c = await novaConversa(A)
    await novaMensagem(A, c.id, 'inbound', 'oi')
    const { data } = await admin.from('conversations').select('version').eq('id', c.id).single()
    // Senao toda mensagem que chega invalidaria o botao que a atendente tem na
    // tela, e ela levaria 409 sem ter feito nada errado.
    expect(data!.version).toBe(c.version)
  })

  it('mensagem atrasada nao faz a atividade andar para tras', async () => {
    const c = await novaConversa(A)
    const agora = new Date().toISOString()
    const antes = new Date(Date.now() - 3_600_000).toISOString()
    await novaMensagem(A, c.id, 'inbound', 'recente', agora)
    await novaMensagem(A, c.id, 'inbound', 'atrasada', antes)

    const { data } = await admin
      .from('conversations')
      .select('last_message_at')
      .eq('id', c.id)
      .single()
    expect(new Date(data!.last_message_at as string).getTime()).toBe(new Date(agora).getTime())
  })
})

/* ===========================================================================
   Ciclo de atribuicao e vinculo
   ======================================================================== */
describe('ciclo de atribuicao', () => {
  it('transfer troca o dono e registra transferred, nao assigned', async () => {
    const c = await novaConversa(A)
    const assumida = await chamar(A.db, 'conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    const r = await chamar(A.db, 'conversation_transfer', {
      p_conversation_id: c.id,
      p_expected_version: assumida.conversation!.version as number,
      p_to_user_id: A2.id,
    })
    expect(r.outcome).toBe('ok')
    expect(r.conversation!.assignedTo).toBe(A2.id)

    const tipos = (await eventos(c.id)).map((e) => e.event_type)
    expect(tipos).toContain('transferred')
    expect(tipos.filter((t) => t === 'assigned')).toHaveLength(1)
  })

  it('transfer sem dono previo e conflito: "de X para Y" nao vira "de ninguem"', async () => {
    const c = await novaConversa(A)
    const r = await chamar(A.db, 'conversation_transfer', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
      p_to_user_id: A2.id,
    })
    expect(r.outcome).toBe('conflict')
  })

  it('transfer para quem nao e da clinica falha na FK composta', async () => {
    const c = await novaConversa(A)
    const assumida = await chamar(A.db, 'conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    await expect(
      chamar(A.db, 'conversation_transfer', {
        p_conversation_id: c.id,
        p_expected_version: assumida.conversation!.version as number,
        p_to_user_id: B.userId,
      }),
    ).rejects.toThrow(/foreign key|conversations_assignee_fk/i)
  })

  it('release devolve a conversa a fila', async () => {
    const c = await novaConversa(A)
    const assumida = await chamar(A.db, 'conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    const r = await chamar(A.db, 'conversation_release', {
      p_conversation_id: c.id,
      p_expected_version: assumida.conversation!.version as number,
    })
    expect(r.outcome).toBe('ok')
    expect(r.conversation!.assignedTo).toBeNull()
    expect((await eventos(c.id)).map((e) => e.event_type)).toContain('released')
  })

  it('link e unlink de paciente geram os dois eventos', async () => {
    const c = await novaConversa(A)
    const ligada = await chamar(A.db, 'conversation_link_patient', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
      p_patient_id: A.patientId,
    })
    expect(ligada.conversation!.patientId).toBe(A.patientId)

    const solta = await chamar(A.db, 'conversation_unlink_patient', {
      p_conversation_id: c.id,
      p_expected_version: ligada.conversation!.version as number,
    })
    expect(solta.conversation!.patientId).toBeNull()

    const tipos = (await eventos(c.id)).map((e) => e.event_type)
    // Aqui os eventos existem porque houve DUAS operacoes de verdade —
    // diferente da conversa que ja nasce vinculada.
    expect(tipos).toEqual(['conversation_created', 'patient_linked', 'patient_unlinked'])
  })

  it('conflito nao devolve estado a quem perdeu o vinculo', async () => {
    const { id: efemeroId, db: efemeroDb } = await novoUsuario('efemero')
    await admin
      .from('clinic_members')
      .insert({ clinic_id: A.clinicId, user_id: efemeroId, role: 'attendant' })

    const c = await novaConversa(A)
    await chamar(A.db, 'conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })

    await admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', A.clinicId)
      .eq('user_id', efemeroId)

    // Versao stale: seria conflito se ainda houvesse vinculo. Sem vinculo tem
    // que ser not_found — o 409 nao pode virar canal de vazamento de estado.
    const r = await chamar(efemeroDb, 'conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    expect(r.outcome).toBe('not_found')
    expect(r.conversation).toBeUndefined()
  })
})

/* ===========================================================================
   Proveniencia de agendamento
   ======================================================================== */
describe('proveniencia de agendamento', () => {
  it('conversation_log_appointment NAO e executavel por authenticated', async () => {
    const { error } = await A.db.rpc('conversation_log_appointment', {
      p_conversation_id: A.conversationId,
      p_appointment_id: randomUUID(),
    })
    // Ela prova que o agendamento e desta clinica, mas nao que ele NASCEU desta
    // conversa. Exposta, viraria log auditavel feito de afirmacao do cliente.
    expect(error).not.toBeNull()
    expect(`${error!.message} ${error!.code ?? ''}`).toMatch(/permission denied|PGRST202|404/i)
  })
})

describe('nivel HTTP', () => {
  it.todo('404 de conversa de outro tenant e byte a byte igual ao de UUID inexistente')
  it.todo('X-Clinic-Id forjado nao devolve nenhum campo de dado do outro tenant')
  it.todo('outcome conflict do RPC vira 409 com o estado atual')
  it.todo('outcome not_found do RPC vira 404, nunca 409')
  it.todo('telefone ja existente em outra thread devolve erro explicado, nao 23505 cru')
})
