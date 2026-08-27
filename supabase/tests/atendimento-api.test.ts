/**
 * =============================================================================
 * ATENDIMENTO — API DE LEITURA (BLOCO 1), PELO HTTP DE VERDADE
 * =============================================================================
 *
 * O que SO aparece aqui, e por isso este arquivo existe separado do
 * `atendimento-schema.test.ts`:
 *
 *   - os guards da API (AuthGuard, ClinicMembershipGuard) no caminho real;
 *   - o header `X-Clinic-Id` chegando como dado hostil, vindo da rede;
 *   - a forma dos DTOs que o frontend vai consumir;
 *   - a paginacao por cursor operando sobre dados reais.
 *
 * As garantias de banco (RLS, FKs compostas, triggers) ja sao cobertas pelo
 * outro arquivo e pelo `verify:migrations`. Repetir aqui so tornaria a suite
 * mais lenta sem provar nada novo.
 *
 * Fixtures sao criadas por run id e removidas pelo manifesto do registry — sem
 * LIKE, sem TRUNCATE, sem tocar em nada que este teste nao criou.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConversationDetail, ConversationListItem, Message, Page } from '@clinicas/shared'
import {
  createActor,
  createAdminClient,
  createAnonClient,
  loadIsolationEnv,
  TestResourceRegistry,
  type IsolationEnv,
  type TestActor,
} from './helpers'

const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000'

let env: IsolationEnv
let admin: SupabaseClient
let registry: TestResourceRegistry
let alice: TestActor
let bob: TestActor
let apiOnline = false

/** Segundo membro da clinica de Alice: sem ele nao da para testar `unassigned`. */
let carol: { userId: string; accessToken: string; db: SupabaseClient }

interface Resposta {
  status: number
  body: string
  json: unknown
}

async function api(
  path: string,
  token: string | null,
  clinicId: string | null,
): Promise<Resposta> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (clinicId) headers['x-clinic-id'] = clinicId

  const response = await fetch(`${env.apiUrl}/api${path}`, { headers })
  const body = await response.text()
  // Guardamos o corpo cru TAMBEM: varias assercoes de vazamento procuram um
  // texto no payload inteiro, e um objeto ja desserializado esconderia campo
  // aninhado que o JSON.stringify da assercao poderia formatar diferente.
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    json = null
  }
  return { status: response.status, body, json }
}

/** Atalho para o caso feliz: Alice, na clinica dela. */
async function comoAlice(path: string): Promise<Resposta> {
  return api(path, alice.accessToken, alice.clinicId)
}

async function criarConversa(
  ator: TestActor,
  opcoes: { telefone?: string | null; nome?: string | null; pacienteId?: string | null } = {},
): Promise<{ id: string; version: number }> {
  const { data, error } = await ator.db.rpc('conversation_create_manual', {
    p_clinic_id: ator.clinicId,
    p_contact_phone_e164: opcoes.telefone ?? null,
    p_contact_name_snapshot: opcoes.nome ?? null,
    p_patient_id: opcoes.pacienteId ?? null,
  })
  if (error) throw new Error(`create_manual: ${error.message}`)
  const r = data as { outcome: string; conversation: { id: string; version: number } }
  if (r.outcome !== 'ok') throw new Error(`create_manual devolveu ${r.outcome}`)
  return { id: r.conversation.id, version: r.conversation.version }
}

async function enviarMensagem(
  ator: TestActor,
  conversationId: string,
  direction: 'inbound' | 'outbound',
  body: string,
  occurredAt: string | null = null,
): Promise<void> {
  const { error } = await ator.db.rpc('conversation_add_manual_message', {
    p_conversation_id: conversationId,
    p_direction: direction,
    p_body: body,
    p_occurred_at: occurredAt,
  })
  if (error) throw new Error(`add_manual_message: ${error.message}`)
}

/* ---------------------------------------------------------------------------
   Cenario

   Clinica A (Alice): cinco conversas com formas diferentes, para exercitar
   filtro, ordenacao e busca sem depender de dado de producao.
   Clinica B (Bob): uma conversa, que Alice nunca pode ver.
------------------------------------------------------------------------------ */

const cenario = {
  vazia: '',
  comPaciente: '',
  atribuidaAlice: '',
  aguardando: '',
  resolvida: '',
  deBob: '',
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)

  const saude = await fetch(`${env.apiUrl}/api/health`).catch(() => null)
  apiOnline = saude?.ok === true
  if (!apiOnline) {
    throw new Error(
      `API precisa estar no ar em ${env.apiUrl} para estes testes. ` +
        'Suba a API ou informe API_URL.',
    )
  }

  alice = await createActor(env, admin, registry, 'atend-a')
  bob = await createActor(env, admin, registry, 'atend-b')

  // Carol entra na clinica de Alice para haver um segundo responsavel possivel.
  const emailCarol = `atend-carol-${registry.testRunId}@example.test`
  const senhaCarol = `Senha-Teste-${registry.testRunId}!`
  const { data: criada, error: erroCarol } = await admin.auth.admin.createUser({
    email: emailCarol,
    password: senhaCarol,
    email_confirm: true,
    user_metadata: { full_name: 'Usuaria CAROL', test_run_id: registry.testRunId },
  })
  if (erroCarol || !criada.user) throw new Error(`carol: ${erroCarol?.message}`)
  registry.registerUser(criada.user.id)
  await admin
    .from('clinic_members')
    .insert({ clinic_id: alice.clinicId, user_id: criada.user.id, role: 'attendant' })

  const dbCarol = createAnonClient(env)
  const { data: sessaoCarol } = await dbCarol.auth.signInWithPassword({
    email: emailCarol,
    password: senhaCarol,
  })
  carol = {
    userId: criada.user.id,
    accessToken: sessaoCarol!.session!.access_token,
    db: dbCarol,
  }

  // --- conversas de A, criadas em ordem crescente de atividade ---------------
  const agora = Date.now()
  const emMinutos = (m: number) => new Date(agora - m * 60_000).toISOString()

  cenario.vazia = (await criarConversa(alice, { nome: 'Contato Sem Mensagem' })).id

  const comPaciente = await criarConversa(alice, {
    nome: 'Joana Ribeiro',
    telefone: '+5511988887777',
    pacienteId: alice.patientId,
  })
  cenario.comPaciente = comPaciente.id
  await enviarMensagem(alice, comPaciente.id, 'inbound', 'Bom dia, posso remarcar?', emMinutos(50))

  const atribuida = await criarConversa(alice, { nome: 'Pedro Alves', telefone: '+5511977776666' })
  cenario.atribuidaAlice = atribuida.id
  await enviarMensagem(alice, atribuida.id, 'inbound', 'Oi', emMinutos(30))
  await enviarMensagem(alice, atribuida.id, 'outbound', 'Ola, tudo bem?', emMinutos(29))
  await alice.db.rpc('conversation_assign', {
    p_conversation_id: atribuida.id,
    p_expected_version: atribuida.version,
  })

  const aguardando = await criarConversa(alice, { nome: 'Marina Souza' })
  cenario.aguardando = aguardando.id
  await enviarMensagem(alice, aguardando.id, 'outbound', 'Enviei sua guia.', emMinutos(20))
  await alice.db.rpc('conversation_set_status', {
    p_conversation_id: aguardando.id,
    p_expected_version: aguardando.version,
    p_status: 'waiting_patient',
  })

  const resolvida = await criarConversa(alice, { nome: 'Caso Encerrado' })
  cenario.resolvida = resolvida.id
  await enviarMensagem(alice, resolvida.id, 'inbound', 'Obrigada!', emMinutos(10))
  await alice.db.rpc('conversation_set_status', {
    p_conversation_id: resolvida.id,
    p_expected_version: resolvida.version,
    p_status: 'resolved',
  })

  // --- conversa da clinica B -------------------------------------------------
  const deBob = await criarConversa(bob, { nome: 'Segredo de B', telefone: '+5511911112222' })
  cenario.deBob = deBob.id
  await enviarMensagem(bob, deBob.id, 'inbound', 'Confidencial da clinica B', emMinutos(5))
}, 240_000)

afterAll(async () => {
  if (registry) await registry.cleanup(admin)
}, 120_000)

/* ===========================================================================
   Autenticacao
   ======================================================================== */
describe('autenticacao', () => {
  it('sem JWT devolve 401 em todas as rotas', async () => {
    const rotas = [
      '/conversations',
      `/conversations/${cenario.comPaciente}`,
      `/conversations/${cenario.comPaciente}/messages`,
      `/conversations/${cenario.comPaciente}/events`,
    ]
    for (const rota of rotas) {
      const r = await api(rota, null, alice.clinicId)
      expect(r.status, rota).toBe(401)
    }
  })

  it('JWT invalido devolve 401, nao 500', async () => {
    const r = await api('/conversations', 'nao-e-um-jwt', alice.clinicId)
    expect(r.status).toBe(401)
  })

  it('sem X-Clinic-Id nao ha acesso', async () => {
    const r = await api('/conversations', alice.accessToken, null)
    expect(r.status).toBe(403)
  })
})

/* ===========================================================================
   Isolamento entre clinicas
   ======================================================================== */
describe('isolamento', () => {
  it('Alice lista somente conversas da clinica dela', async () => {
    const r = await comoAlice('/conversations?limit=100')
    expect(r.status).toBe(200)
    const page = r.json as Page<ConversationListItem>
    const ids = page.items.map((i) => i.id)

    expect(ids).toContain(cenario.comPaciente)
    expect(ids).not.toContain(cenario.deBob)
    // Nenhum campo da clinica B pode aparecer no corpo — nao basta o id sumir.
    expect(r.body).not.toContain('Segredo de B')
    expect(r.body).not.toContain('Confidencial da clinica B')
  })

  it('Bob nao ve nada da clinica A', async () => {
    const r = await api('/conversations?limit=100', bob.accessToken, bob.clinicId)
    const page = r.json as Page<ConversationListItem>
    expect(page.items.map((i) => i.id)).not.toContain(cenario.comPaciente)
    expect(r.body).not.toContain('Joana Ribeiro')
  })

  it('X-Clinic-Id forjado nao devolve dado nenhum do outro tenant', async () => {
    // JWT de Alice + header apontando para a clinica de Bob.
    const rotas = [
      '/conversations?limit=100',
      `/conversations/${cenario.deBob}`,
      `/conversations/${cenario.deBob}/messages`,
      `/conversations/${cenario.deBob}/events`,
    ]
    for (const rota of rotas) {
      const r = await api(rota, alice.accessToken, bob.clinicId)
      expect([403, 404], `${rota} -> ${r.status}`).toContain(r.status)
      expect(r.body).not.toContain('Segredo de B')
      expect(r.body).not.toContain('Confidencial da clinica B')
      expect(r.body).not.toContain(bob.patientName)
    }
  })

  it('X-Clinic-Id de clinica inexistente e recusado igual', async () => {
    const r = await api('/conversations', alice.accessToken, UUID_INEXISTENTE)
    expect(r.status).toBe(403)
  })

  it('conversa de outro tenant e 404 IDENTICO ao de um id inexistente', async () => {
    const alheia = await comoAlice(`/conversations/${cenario.deBob}`)
    const inexistente = await comoAlice(`/conversations/${UUID_INEXISTENTE}`)

    expect(alheia.status).toBe(404)
    expect(inexistente.status).toBe(404)
    // Byte a byte: qualquer diferenca aqui confirmaria que a conversa de B
    // existe, que e exatamente a informacao que nao pode vazar.
    expect(alheia.body).toBe(inexistente.body)
  })

  it('messages e events de conversa alheia sao 404, nao lista vazia', async () => {
    for (const sufixo of ['messages', 'events']) {
      const alheia = await comoAlice(`/conversations/${cenario.deBob}/${sufixo}`)
      const inexistente = await comoAlice(`/conversations/${UUID_INEXISTENTE}/${sufixo}`)
      // 200 com lista vazia seria indistinguivel de "existe e esta vazia" —
      // e confirmaria o caminho.
      expect(alheia.status, sufixo).toBe(404)
      expect(alheia.body).toBe(inexistente.body)
    }
  })

  it('paciente vinculado nunca cruza tenant', async () => {
    const r = await comoAlice(`/conversations/${cenario.comPaciente}`)
    const detalhe = r.json as ConversationDetail
    expect(detalhe.patient?.id).toBe(alice.patientId)
    expect(r.body).not.toContain(bob.patientId)
    expect(r.body).not.toContain(bob.patientName)
  })

  it('membership removido derruba o acesso na requisicao seguinte', async () => {
    const antes = await api('/conversations', carol.accessToken, alice.clinicId)
    expect(antes.status).toBe(200)

    await admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', alice.clinicId)
      .eq('user_id', carol.userId)

    // Mesmo JWT, ainda valido. O que mudou foi o vinculo, e o guard consulta o
    // banco a cada requisicao em vez de confiar em algo embutido no token.
    const depois = await api('/conversations', carol.accessToken, alice.clinicId)
    expect(depois.status).toBe(403)

    await admin
      .from('clinic_members')
      .insert({ clinic_id: alice.clinicId, user_id: carol.userId, role: 'attendant' })
  })
})

/* ===========================================================================
   Lista: forma, filtros, ordenacao, busca
   ======================================================================== */
describe('lista de conversas', () => {
  it('clinica sem conversas devolve lista vazia, nao 404', async () => {
    // Bob filtra por um paciente que existe mas nao tem conversa.
    const r = await api(
      `/conversations?patientId=${bob.patientId}`,
      bob.accessToken,
      bob.clinicId,
    )
    expect(r.status).toBe(200)
    const page = r.json as Page<ConversationListItem>
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('o item traz o necessario para desenhar a fila, e nada da thread', async () => {
    const r = await comoAlice(`/conversations?limit=100`)
    const item = (r.json as Page<ConversationListItem>).items.find(
      (i) => i.id === cenario.atribuidaAlice,
    )!

    expect(item).toMatchObject({
      channel: 'manual',
      status: 'open',
      assignedTo: alice.userId,
      assignedToIsMe: true,
      contactNameSnapshot: 'Pedro Alves',
      lastMessagePreview: 'Ola, tudo bem?',
      lastMessageDirection: 'outbound',
      needsReply: false,
    })
    expect(typeof item.version).toBe('number')
    // A listagem nao carrega a thread.
    expect(item).not.toHaveProperty('messages')
    expect(item).not.toHaveProperty('clinicId')
  })

  it('needsReply marca quem falou por ultimo foi o paciente', async () => {
    const r = await comoAlice('/conversations?limit=100')
    const items = (r.json as Page<ConversationListItem>).items
    expect(items.find((i) => i.id === cenario.comPaciente)!.needsReply).toBe(true)
    expect(items.find((i) => i.id === cenario.atribuidaAlice)!.needsReply).toBe(false)
  })

  it('ordena por atividade recente, com as sem mensagem no fim', async () => {
    const r = await comoAlice('/conversations?limit=100')
    const ids = (r.json as Page<ConversationListItem>).items.map((i) => i.id)

    const pos = (id: string) => ids.indexOf(id)
    // resolvida (10min) mais recente que aguardando (20) que atribuida (29).
    expect(pos(cenario.resolvida)).toBeLessThan(pos(cenario.aguardando))
    expect(pos(cenario.aguardando)).toBeLessThan(pos(cenario.atribuidaAlice))
    expect(pos(cenario.atribuidaAlice)).toBeLessThan(pos(cenario.comPaciente))
    // A que nunca recebeu mensagem vai para o fim, nao para o topo.
    expect(pos(cenario.vazia)).toBe(ids.length - 1)
  })

  it('filtra por status', async () => {
    const abertas = await comoAlice('/conversations?status=open&limit=100')
    const ids = (abertas.json as Page<ConversationListItem>).items.map((i) => i.id)
    expect(ids).toContain(cenario.atribuidaAlice)
    expect(ids).not.toContain(cenario.resolvida)
    expect(ids).not.toContain(cenario.aguardando)

    const resolvidas = await comoAlice('/conversations?status=resolved&limit=100')
    expect((resolvidas.json as Page<ConversationListItem>).items.map((i) => i.id)).toEqual([
      cenario.resolvida,
    ])
  })

  it('assignment=mine devolve so as de quem pergunta', async () => {
    const minhas = await comoAlice('/conversations?assignment=mine&limit=100')
    const items = (minhas.json as Page<ConversationListItem>).items
    expect(items.map((i) => i.id)).toEqual([cenario.atribuidaAlice])
    expect(items.every((i) => i.assignedTo === alice.userId)).toBe(true)

    // Para Carol, a MESMA rota devolve outro conjunto: `mine` sai do JWT.
    const deCarol = await api(
      '/conversations?assignment=mine&limit=100',
      carol.accessToken,
      alice.clinicId,
    )
    expect((deCarol.json as Page<ConversationListItem>).items).toEqual([])
  })

  it('assignment=unassigned devolve a fila sem dono', async () => {
    const r = await comoAlice('/conversations?assignment=unassigned&limit=100')
    const items = (r.json as Page<ConversationListItem>).items
    expect(items.every((i) => i.assignedTo === null)).toBe(true)
    expect(items.map((i) => i.id)).not.toContain(cenario.atribuidaAlice)
    expect(items.map((i) => i.id)).toContain(cenario.comPaciente)
  })

  it('busca por nome do contato', async () => {
    const r = await comoAlice('/conversations?q=joana&limit=100')
    const ids = (r.json as Page<ConversationListItem>).items.map((i) => i.id)
    expect(ids).toEqual([cenario.comPaciente])
  })

  it('busca por telefone aceita o que a pessoa digita', async () => {
    // Sem o "+55", com formatacao: o servidor extrai os digitos.
    const r = await comoAlice('/conversations?q=98888-7777&limit=100')
    expect((r.json as Page<ConversationListItem>).items.map((i) => i.id)).toEqual([
      cenario.comPaciente,
    ])
  })

  it('busca nao vaza para outra clinica', async () => {
    const r = await comoAlice('/conversations?q=Segredo&limit=100')
    expect((r.json as Page<ConversationListItem>).items).toEqual([])
  })

  it('conversa com e sem paciente aparecem com o campo certo', async () => {
    const r = await comoAlice('/conversations?limit=100')
    const items = (r.json as Page<ConversationListItem>).items
    expect(items.find((i) => i.id === cenario.comPaciente)!.patientName).toBe(alice.patientName)
    expect(items.find((i) => i.id === cenario.vazia)!.patientId).toBeNull()
    expect(items.find((i) => i.id === cenario.vazia)!.patientName).toBeNull()
  })

  it('limite invalido e recusado com 400, nao ignorado', async () => {
    expect((await comoAlice('/conversations?limit=0')).status).toBe(400)
    expect((await comoAlice('/conversations?limit=9999')).status).toBe(400)
    expect((await comoAlice('/conversations?status=inventado')).status).toBe(400)
  })

  it('cursor percorre a fila inteira sem repetir nem perder', async () => {
    const vistos: string[] = []
    let cursor: string | null = null
    let voltas = 0

    do {
      const url: string = `/conversations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const r: Resposta = await comoAlice(url)
      expect(r.status).toBe(200)
      const page = r.json as Page<ConversationListItem>
      vistos.push(...page.items.map((i) => i.id))
      cursor = page.nextCursor
      voltas += 1
    } while (cursor && voltas < 20)

    expect(cursor).toBeNull()
    expect(new Set(vistos).size).toBe(vistos.length)
    // As cinco de A, incluindo a que nao tem mensagem — o ramo dos nulos do
    // cursor e justamente onde a paginacao costuma parar cedo demais.
    expect(new Set(vistos)).toEqual(new Set(Object.values(cenario).filter((id) => id !== cenario.deBob)))
  })

  it('cursor corrompido e 400, nao primeira pagina em silencio', async () => {
    expect((await comoAlice('/conversations?cursor=lixo!!')).status).toBe(400)
  })
})

/* ===========================================================================
   Detalhe
   ======================================================================== */
describe('detalhe da conversa', () => {
  it('traz o operacional completo e o paciente resumido', async () => {
    const r = await comoAlice(`/conversations/${cenario.comPaciente}`)
    expect(r.status).toBe(200)
    const d = r.json as ConversationDetail

    expect(d).toMatchObject({
      id: cenario.comPaciente,
      clinicId: alice.clinicId,
      channel: 'manual',
      status: 'open',
      needsReply: true,
    })
    expect(d.patient).toMatchObject({ id: alice.patientId, name: alice.patientName })
    // Resumo, nao o cadastro inteiro: a tela identifica e liga, nao edita.
    expect(d.patient).not.toHaveProperty('birthDate')
    expect(d.patient).not.toHaveProperty('insuranceProvider')
    // A thread tem endpoint proprio.
    expect(d).not.toHaveProperty('messages')
  })

  it('conversa sem paciente traz patient nulo, sem inventar', async () => {
    const r = await comoAlice(`/conversations/${cenario.vazia}`)
    const d = r.json as ConversationDetail
    expect(d.patient).toBeNull()
    expect(d.nextAppointment).toBeNull()
  })

  it('assignedToIsMe distingue quem atende', async () => {
    const daAlice = await comoAlice(`/conversations/${cenario.atribuidaAlice}`)
    expect((daAlice.json as ConversationDetail).assignedToIsMe).toBe(true)

    const deCarol = await api(
      `/conversations/${cenario.atribuidaAlice}`,
      carol.accessToken,
      alice.clinicId,
    )
    expect((deCarol.json as ConversationDetail).assignedToIsMe).toBe(false)
    // O nome sai da auditoria; Alice ja agiu, entao existe snapshot dela.
    expect((deCarol.json as ConversationDetail).assignedToName).toBe('Usuario ATEND-A')
  })
})

/* ===========================================================================
   Mensagens
   ======================================================================== */
describe('thread de mensagens', () => {
  it('vem em ordem cronologica com autoria e registro separados', async () => {
    const r = await comoAlice(`/conversations/${cenario.atribuidaAlice}/messages`)
    expect(r.status).toBe(200)
    const page = r.json as Page<Message>

    expect(page.items.map((m) => m.body)).toEqual(['Oi', 'Ola, tudo bem?'])

    const [entrada, saida] = page.items
    // Inbound: quem DISSE foi o paciente; quem REGISTROU foi Alice.
    expect(entrada!.authorUserId).toBeNull()
    expect(entrada!.recordedByUserId).toBe(alice.userId)
    expect(saida!.authorUserId).toBe(alice.userId)
    // Manual nunca finge entrega.
    expect(saida!.deliveryStatus).toBeNull()
    expect(saida!.channel).toBe('manual')
  })

  it('pagina a thread por cursor', async () => {
    const primeira = await comoAlice(`/conversations/${cenario.atribuidaAlice}/messages?limit=1`)
    const p1 = primeira.json as Page<Message>
    expect(p1.items).toHaveLength(1)
    expect(p1.nextCursor).not.toBeNull()

    const segunda = await comoAlice(
      `/conversations/${cenario.atribuidaAlice}/messages?limit=1&cursor=${encodeURIComponent(p1.nextCursor!)}`,
    )
    const p2 = segunda.json as Page<Message>
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id)
    expect(p2.nextCursor).toBeNull()
  })

  it('conversa sem mensagens devolve lista vazia', async () => {
    const r = await comoAlice(`/conversations/${cenario.vazia}/messages`)
    expect(r.status).toBe(200)
    expect((r.json as Page<Message>).items).toEqual([])
  })
})

/* ===========================================================================
   Auditoria
   ======================================================================== */
describe('eventos', () => {
  it('conta a historia da conversa com nome de quem agiu', async () => {
    const r = await comoAlice(`/conversations/${cenario.atribuidaAlice}/events`)
    expect(r.status).toBe(200)
    const page = r.json as Page<{
      eventType: string
      actorNameSnapshot: string | null
      metadata: Record<string, unknown>
    }>

    const tipos = page.items.map((e) => e.eventType)
    expect(tipos).toEqual(['conversation_created', 'assigned'])

    const assumiu = page.items.find((e) => e.eventType === 'assigned')!
    // E daqui que sai "Alice assumiu o atendimento".
    expect(assumiu.actorNameSnapshot).toBe('Usuario ATEND-A')
  })

  it('status_changed carrega de/para', async () => {
    const r = await comoAlice(`/conversations/${cenario.aguardando}/events`)
    const page = r.json as Page<{ eventType: string; metadata: Record<string, unknown> }>
    const mudanca = page.items.find((e) => e.eventType === 'status_changed')!
    expect(mudanca.metadata).toMatchObject({ from: 'open', to: 'waiting_patient' })
  })

  it('metadata sai pela lista branca, sem campos internos', async () => {
    const r = await comoAlice(`/conversations/${cenario.aguardando}/events`)
    const page = r.json as Page<{ metadata: Record<string, unknown> }>
    const permitidas = new Set([
      'from',
      'to',
      'reason',
      'from_user_id',
      'to_user_id',
      'patient_id',
      'appointment_id',
    ])
    for (const evento of page.items) {
      for (const chave of Object.keys(evento.metadata)) {
        expect(permitidas.has(chave), `chave inesperada: ${chave}`).toBe(true)
      }
    }
  })

  it('nao expoe ids internos de auditoria alem do necessario', async () => {
    const r = await comoAlice(`/conversations/${cenario.aguardando}/events`)
    const page = r.json as Page<Record<string, unknown>>
    // clinicId e conversationId ja sao conhecidos por quem pediu; actorUserId
    // nao acrescenta nada a UI e e identificador de pessoa.
    expect(page.items[0]).not.toHaveProperty('clinicId')
    expect(page.items[0]).not.toHaveProperty('conversationId')
    expect(page.items[0]).not.toHaveProperty('actorUserId')
  })
})

/* ===========================================================================
   Diretorio da equipe
   ======================================================================== */
describe('diretorio da equipe', () => {
  it('membro enxerga a equipe da propria clinica, com nome vindo de profiles', async () => {
    const { data, error } = await alice.db.rpc('clinic_member_directory', {
      p_clinic_id: alice.clinicId,
    })
    expect(error).toBeNull()
    const equipe = data as { user_id: string; display_name: string | null; role: string }[]

    const daAlice = equipe.find((m) => m.user_id === alice.userId)
    expect(daAlice?.display_name).toBe('Usuario ATEND-A')
    expect(daAlice?.role).toBe('admin')

    const daCarol = equipe.find((m) => m.user_id === carol.userId)
    expect(daCarol?.display_name).toBe('Usuaria CAROL')
    expect(daCarol?.role).toBe('attendant')
  })

  it('o SEGUNDO membro enxerga a mesma equipe', async () => {
    const { data } = await carol.db.rpc('clinic_member_directory', {
      p_clinic_id: alice.clinicId,
    })
    const ids = (data as { user_id: string }[]).map((m) => m.user_id).sort()
    expect(ids).toEqual([alice.userId, carol.userId].sort())
  })

  it('quem e de outra clinica recebe CONJUNTO VAZIO, nao erro', async () => {
    const { data, error } = await bob.db.rpc('clinic_member_directory', {
      p_clinic_id: alice.clinicId,
    })
    // Vazio e nao excecao: um erro diferente ja seria a confirmacao de que a
    // clinica existe.
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('mandar o clinic_id do outro tenant nao ajuda em nada', async () => {
    // p_clinic_id e dado do cliente e nao vale como prova: quem decide e
    // is_clinic_member(auth.uid()), por dentro da funcao.
    const { data: alheia } = await alice.db.rpc('clinic_member_directory', {
      p_clinic_id: bob.clinicId,
    })
    const { data: inexistente } = await alice.db.rpc('clinic_member_directory', {
      p_clinic_id: UUID_INEXISTENTE,
    })
    expect(alheia).toEqual([])
    // Mesma resposta para "nao e sua" e "nao existe".
    expect(alheia).toEqual(inexistente)
  })

  it('anon nao tem EXECUTE', async () => {
    const anon = createAnonClient(env)
    const { error } = await anon.rpc('clinic_member_directory', { p_clinic_id: alice.clinicId })
    expect(error).not.toBeNull()
  })

  it('devolve exatamente tres colunas — sem email, sem metadados', async () => {
    const { data } = await alice.db.rpc('clinic_member_directory', {
      p_clinic_id: alice.clinicId,
    })
    for (const membro of data as Record<string, unknown>[]) {
      expect(Object.keys(membro).sort()).toEqual(['display_name', 'role', 'user_id'])
    }
  })

  it('resolve o nome de quem esta atribuido mas NUNCA agiu', async () => {
    /*
     * ESTE E O TESTE QUE JUSTIFICA A MUDANCA.
     *
     * A conversa e transferida PARA Carol POR Alice: o evento registra Alice
     * como ator, e Carol nao tem evento proprio nenhum. Pelo caminho antigo —
     * inferir o nome do snapshot mais recente em conversation_events — o nome
     * de Carol seria irresolvivel, e a fila mostraria a conversa como se nao
     * tivesse responsavel.
     */
    const c = await criarConversa(alice, { nome: 'Transferida para quem nunca agiu' })
    const { data: assumida } = await alice.db.rpc('conversation_assign', {
      p_conversation_id: c.id,
      p_expected_version: c.version,
    })
    const versao = (assumida as { conversation: { version: number } }).conversation.version
    await alice.db.rpc('conversation_transfer', {
      p_conversation_id: c.id,
      p_expected_version: versao,
      p_to_user_id: carol.userId,
    })

    // Carol realmente nao deixou rastro nenhum nesta conversa.
    const { data: eventos } = await admin
      .from('conversation_events')
      .select('actor_user_id')
      .eq('conversation_id', c.id)
    expect((eventos ?? []).every((e) => e.actor_user_id !== carol.userId)).toBe(true)

    const r = await comoAlice(`/conversations/${c.id}`)
    const detalhe = r.json as ConversationDetail
    expect(detalhe.assignedTo).toBe(carol.userId)
    expect(detalhe.assignedToName).toBe('Usuaria CAROL')
    expect(detalhe.assignedToIsMe).toBe(false)

    // E na listagem tambem.
    const lista = await comoAlice('/conversations?limit=100')
    const item = (lista.json as Page<ConversationListItem>).items.find((i) => i.id === c.id)!
    expect(item.assignedToName).toBe('Usuaria CAROL')
  })

  it('toda conversa com responsavel tem nome resolvido — sem N+1', async () => {
    // O diretorio e carregado UMA vez por requisicao e mapeado em memoria;
    // buscar nome por conversa seria N+1.
    const r = await comoAlice('/conversations?limit=100')
    const comDono = (r.json as Page<ConversationListItem>).items.filter(
      (i) => i.assignedTo !== null,
    )
    expect(comDono.length).toBeGreaterThan(0)
    for (const item of comDono) {
      expect(item.assignedToName, `sem nome: ${item.id}`).not.toBeNull()
    }
  })
})
