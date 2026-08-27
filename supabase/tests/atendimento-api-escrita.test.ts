/**
 * =============================================================================
 * ATENDIMENTO — REGISTRO MANUAL (BLOCO 2), PELO HTTP DE VERDADE
 * =============================================================================
 *
 * "Registro", nao "envio". Nada aqui manda mensagem para ninguem: o modo manual
 * anota no sistema uma conversa que aconteceu por fora — telefone, balcao,
 * WhatsApp pessoal. Varias assercoes existem justamente para garantir que o
 * sistema nunca finja o contrario (delivery_status nulo, canal manual).
 *
 * Fixtures proprias, separadas das do arquivo de leitura de proposito: estes
 * testes CRIAM conversas, e compartilhar o cenario faria as assercoes de lista
 * do outro arquivo quebrarem conforme este crescesse.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  Conversation,
  Message,
  RegisterConversationResult,
  RegisterManualMessageResult,
} from '@clinicas/shared'
import {
  createActor,
  createAdminClient,
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

interface Resposta {
  status: number
  body: string
  json: unknown
}

async function post(
  path: string,
  token: string | null,
  clinicId: string | null,
  payload: unknown,
): Promise<Resposta> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (clinicId) headers['x-clinic-id'] = clinicId

  const response = await fetch(`${env.apiUrl}/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  const body = await response.text()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    json = null
  }
  return { status: response.status, body, json }
}

async function get(path: string, token: string, clinicId: string): Promise<Resposta> {
  const response = await fetch(`${env.apiUrl}/api${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'x-clinic-id': clinicId },
  })
  const body = await response.text()
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    json = null
  }
  return { status: response.status, body, json }
}

/** Cria como Alice e devolve a conversa, falhando alto se o status divergir. */
async function criar(payload: unknown, esperado = 201): Promise<RegisterConversationResult> {
  const r = await post('/conversations', alice.accessToken, alice.clinicId, payload)
  expect(r.status, `criar -> ${r.body.slice(0, 200)}`).toBe(esperado)
  return r.json as RegisterConversationResult
}

/** Telefone unico por execucao: duas rodadas nao podem colidir entre si. */
let sequenciaTelefone = 0
function telefoneNovo(): string {
  sequenciaTelefone += 1
  const sufixo = String(Date.now()).slice(-6) + String(sequenciaTelefone).padStart(2, '0')
  return `9${sufixo}`
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)

  const saude = await fetch(`${env.apiUrl}/api/health`).catch(() => null)
  if (saude?.ok !== true) {
    throw new Error(`API precisa estar no ar em ${env.apiUrl} para estes testes.`)
  }

  alice = await createActor(env, admin, registry, 'escrita-a')
  bob = await createActor(env, admin, registry, 'escrita-b')
}, 240_000)

afterAll(async () => {
  if (registry) await registry.cleanup(admin)
}, 120_000)

/* ===========================================================================
   Criacao manual
   ======================================================================== */
describe('POST /conversations', () => {
  it('sem JWT devolve 401', async () => {
    const r = await post('/conversations', null, alice.clinicId, { contactName: 'X' })
    expect(r.status).toBe(401)
  })

  it('sem header de clinica devolve 403', async () => {
    const r = await post('/conversations', alice.accessToken, null, { contactName: 'X' })
    expect(r.status).toBe(403)
  })

  it('cria sem paciente e o BANCO decide o estado inicial', async () => {
    const r = await criar({ contactName: 'Sem Paciente' })

    expect(r.created).toBe(true)
    expect(r.conversation).toMatchObject({
      clinicId: alice.clinicId,
      channel: 'manual',
      provider: null,
      status: 'open',
      assignedTo: null,
      version: 1,
      patientId: null,
      contactNameSnapshot: 'Sem Paciente',
    })
  })

  it('campos de controle sao RECUSADOS, nao descartados em silencio', async () => {
    // Descartar devolveria 201 e uma conversa manual para quem pediu WhatsApp;
    // a pessoa so descobriria ao notar que nada foi enviado. Recusar
    // transforma o mal-entendido em erro imediato.
    for (const campo of [
      { channel: 'whatsapp' },
      { provider: 'evolution' },
      { status: 'resolved' },
      { assignedTo: bob.userId },
      { version: 99 },
      { createdAt: '1999-01-01T00:00:00.000Z' },
      { clinicId: bob.clinicId },
    ]) {
      const r = await post('/conversations', alice.accessToken, alice.clinicId, {
        contactName: 'Tentativa de forja',
        ...campo,
      })
      expect(r.status, JSON.stringify(campo)).toBe(400)
    }
  })

  it('e mesmo se passassem, a RPC nao tem parametro para eles', async () => {
    // Segunda barreira, independente do schema: `conversation_create_manual`
    // recebe quatro argumentos e nenhum e de controle.
    const r = await criar({ contactName: 'Estado inicial' })
    expect(r.conversation).toMatchObject({
      clinicId: alice.clinicId,
      channel: 'manual',
      provider: null,
      status: 'open',
      assignedTo: null,
      version: 1,
    })
    expect(new Date(r.conversation.createdAt).getFullYear()).toBeGreaterThan(2020)
  })

  it('cria com paciente da propria clinica', async () => {
    const r = await criar({ contactName: 'Com Paciente', patientId: alice.patientId })
    expect(r.conversation.patientId).toBe(alice.patientId)
  })

  it('nascer vinculada NAO fabrica um patient_linked', async () => {
    const r = await criar({ contactName: 'Vinculada na criacao', patientId: alice.patientId })
    const eventos = await get(
      `/conversations/${r.conversation.id}/events`,
      alice.accessToken,
      alice.clinicId,
    )
    const page = eventos.json as { items: { eventType: string; metadata: { patient_id?: string } }[] }

    // Um evento so: ninguem executou uma operacao de vincular. Inventar um
    // patient_linked poria na auditoria uma acao que nunca houve.
    expect(page.items.map((e) => e.eventType)).toEqual(['conversation_created'])
    expect(page.items[0]!.metadata.patient_id).toBe(alice.patientId)
  })

  it('paciente de OUTRA clinica nao revela existencia', async () => {
    const r = await post('/conversations', alice.accessToken, alice.clinicId, {
      contactName: 'Cross tenant',
      patientId: bob.patientId,
    })
    // A FK composta tenant-first barra estruturalmente. O que sai e um erro de
    // dados, sem dizer se aquele paciente existe em algum lugar.
    expect([400, 404]).toContain(r.status)
    expect(r.body).not.toContain(bob.patientName)
    expect(r.body).not.toContain(bob.clinicId)
  })

  it('paciente inexistente e indistinguivel de paciente alheio', async () => {
    const alheio = await post('/conversations', alice.accessToken, alice.clinicId, {
      contactName: 'X',
      patientId: bob.patientId,
    })
    const inexistente = await post('/conversations', alice.accessToken, alice.clinicId, {
      contactName: 'X',
      patientId: UUID_INEXISTENTE,
    })
    expect(alheio.status).toBe(inexistente.status)
    expect(alheio.body).toBe(inexistente.body)
  })

  it('body invalido devolve 400', async () => {
    const casos: unknown[] = [
      { contactName: 'x'.repeat(200) },
      { patientId: 'nao-e-uuid' },
      { contactPhone: 12345 },
    ]
    for (const caso of casos) {
      const r = await post('/conversations', alice.accessToken, alice.clinicId, caso)
      expect(r.status, JSON.stringify(caso)).toBe(400)
    }
  })
})

/* ===========================================================================
   Telefone
   ======================================================================== */
describe('normalizacao de telefone', () => {
  it('numero brasileiro digitado com mascara vira E.164', async () => {
    const nacional = telefoneNovo()
    const r = await criar({ contactName: 'Mascarado', contactPhone: `(11) ${nacional}` })
    expect(r.conversation.contactPhoneE164).toBe(`+5511${nacional.replace(/\D/g, '')}`)
  })

  it('numero ja em E.164 brasileiro e idempotente', async () => {
    const e164 = `+5511${telefoneNovo()}`
    const r = await criar({ contactName: 'Ja normalizado', contactPhone: e164 })
    expect(r.conversation.contactPhoneE164).toBe(e164)
  })

  it('numero estrangeiro NUNCA recebe +55 — e recusado', async () => {
    const r = await post('/conversations', alice.accessToken, alice.clinicId, {
      contactName: 'Estrangeiro',
      contactPhone: '+1 415 555 0100',
    })
    // O helper se recusa a adivinhar o pais. O que NAO pode acontecer, em
    // hipotese alguma, e o numero virar brasileiro: isso poria duas pessoas
    // diferentes na mesma thread.
    expect(r.status).toBe(400)
    expect(r.body).not.toContain('+5514155550100')
    expect(r.body).not.toContain('+55')
  })

  it('telefone invalido devolve 400', async () => {
    for (const invalido of ['123', 'abc', '+55', '11 9']) {
      const r = await post('/conversations', alice.accessToken, alice.clinicId, {
        contactPhone: invalido,
      })
      expect(r.status, invalido).toBe(400)
    }
  })

  it('telefone repetido devolve 200 com a conversa EXISTENTE, nao 409', async () => {
    const telefone = `+5511${telefoneNovo()}`

    const primeira = await criar({ contactName: 'Primeira', contactPhone: telefone })
    expect(primeira.created).toBe(true)

    const segunda = await criar({ contactName: 'Outro nome', contactPhone: telefone }, 200)
    expect(segunda.created).toBe(false)
    expect(segunda.conversation.id).toBe(primeira.conversation.id)
    // A thread existente nao e reescrita pela segunda tentativa.
    expect(segunda.conversation.contactNameSnapshot).toBe('Primeira')
  })

  it('a mesma pessoa em clinicas diferentes tem threads independentes', async () => {
    const telefone = `+5511${telefoneNovo()}`

    const emA = await criar({ contactName: 'Em A', contactPhone: telefone })
    const emB = await post('/conversations', bob.accessToken, bob.clinicId, {
      contactName: 'Em B',
      contactPhone: telefone,
    })

    expect(emB.status).toBe(201)
    const criadaEmB = emB.json as RegisterConversationResult
    expect(criadaEmB.created).toBe(true)
    expect(criadaEmB.conversation.id).not.toBe(emA.conversation.id)
    expect(criadaEmB.conversation.clinicId).toBe(bob.clinicId)
  })
})

/* ===========================================================================
   Registro de mensagem manual
   ======================================================================== */
describe('POST /conversations/:id/messages', () => {
  let conversa: Conversation

  beforeAll(async () => {
    conversa = (await criar({ contactName: 'Thread de mensagens' })).conversation
  })

  async function registrar(
    payload: unknown,
    conversationId = conversa.id,
    esperado = 201,
  ): Promise<RegisterManualMessageResult> {
    const r = await post(
      `/conversations/${conversationId}/messages`,
      alice.accessToken,
      alice.clinicId,
      payload,
    )
    expect(r.status, `registrar -> ${r.body.slice(0, 200)}`).toBe(esperado)
    return r.json as RegisterManualMessageResult
  }

  it('inbound: o paciente falou, a atendente registrou', async () => {
    const r = await registrar({ direction: 'inbound', body: 'Ligou perguntando o horario.' })

    // Quem DISSE foi o paciente — nao ha autor do lado da clinica.
    expect(r.message.authorUserId).toBeNull()
    expect(r.message.authorNameSnapshot).toBeNull()
    // Quem REGISTROU foi quem estava logado.
    expect(r.message.recordedByUserId).toBe(alice.userId)
    expect(r.message.recordedByNameSnapshot).toBe('Usuario ESCRITA-A')
  })

  it('outbound: autor e registrador sao a mesma pessoa', async () => {
    const r = await registrar({ direction: 'outbound', body: 'Retornei a ligacao.' })
    expect(r.message.authorUserId).toBe(alice.userId)
    expect(r.message.recordedByUserId).toBe(alice.userId)
  })

  it('registro manual NUNCA finge entrega', async () => {
    const r = await registrar({ direction: 'outbound', body: 'Nada foi enviado por aqui.' })
    // Este endpoint nao aciona provedor nenhum. Exibir "entregue" seria mentir
    // para a equipe sobre uma mensagem que o paciente nunca recebeu.
    expect(r.message.deliveryStatus).toBeNull()
    expect(r.message.channel).toBe('manual')
    expect(r.message.provider).toBeNull()
    expect(r.message.providerMessageId).toBeNull()
  })

  it('tentar afirmar autoria, tenant ou entrega e RECUSADO', async () => {
    // Quem envia `deliveryStatus: 'delivered'` esta afirmando algo que nao lhe
    // cabe. Aceitar e descartar deixaria o autor do cliente achando que a
    // afirmacao valeu.
    for (const campo of [
      { authorUserId: bob.userId },
      { authorNameSnapshot: 'Nome Falso' },
      { recordedByUserId: bob.userId },
      { recordedByNameSnapshot: 'Outro Falso' },
      { clinicId: bob.clinicId },
      { channel: 'whatsapp' },
      { provider: 'evolution' },
      { providerMessageId: 'forjado-123' },
      { deliveryStatus: 'delivered' },
    ]) {
      const r = await post(
        `/conversations/${conversa.id}/messages`,
        alice.accessToken,
        alice.clinicId,
        { direction: 'inbound', body: 'Tentando forjar', ...campo },
      )
      expect(r.status, JSON.stringify(campo)).toBe(400)
    }
  })

  it('a autoria real vem do JWT, nao do corpo', async () => {
    // Segunda barreira: mesmo sem nenhum campo forjado, quem carimba autoria e
    // o trigger, a partir de auth.uid(). A API nao monta snapshot.
    const r = await registrar({ direction: 'outbound', body: 'quem assina sou eu' })
    expect(r.message.authorUserId).toBe(alice.userId)
    expect(r.message.authorNameSnapshot).toBe('Usuario ESCRITA-A')
    expect(r.message.clinicId).toBe(alice.clinicId)
    expect(r.message.channel).toBe('manual')
    expect(r.message.provider).toBeNull()
    expect(r.message.providerMessageId).toBeNull()
    expect(r.message.deliveryStatus).toBeNull()
  })

  it('duas mensagens identicas continuam sendo duas mensagens', async () => {
    const texto = 'Confirmou por telefone.'
    await registrar({ direction: 'outbound', body: texto })
    await registrar({ direction: 'outbound', body: texto })

    const thread = await get(
      `/conversations/${conversa.id}/messages?limit=100`,
      alice.accessToken,
      alice.clinicId,
    )
    const iguais = (thread.json as { items: Message[] }).items.filter((m) => m.body === texto)
    // Repetir a mesma frase e legitimo: a pessoa ligou duas vezes. Deduplicar
    // por conteudo apagaria um fato real.
    expect(iguais).toHaveLength(2)
  })

  it('devolve o estado da conversa junto, sem exigir refresh', async () => {
    const r = await registrar({ direction: 'inbound', body: 'Mais uma.' })
    expect(r.conversation.id).toBe(conversa.id)
    expect(r.conversation.lastMessageAt).not.toBeNull()
  })

  it('body invalido e direction invalida devolvem 400', async () => {
    const casos: unknown[] = [
      { direction: 'inbound', body: '' },
      { direction: 'inbound', body: '   ' },
      { direction: 'lateral', body: 'oi' },
      { direction: 'inbound' },
      { body: 'sem direcao' },
      { direction: 'inbound', body: 'x'.repeat(5000) },
    ]
    for (const caso of casos) {
      const r = await post(
        `/conversations/${conversa.id}/messages`,
        alice.accessToken,
        alice.clinicId,
        caso,
      )
      expect(r.status, JSON.stringify(caso).slice(0, 60)).toBe(400)
    }
  })

  it('conversa de outro tenant e 404 IDENTICO ao de id inexistente', async () => {
    const deBob = await post('/conversations', bob.accessToken, bob.clinicId, {
      contactName: 'Thread de B',
    })
    const idDeBob = (deBob.json as RegisterConversationResult).conversation.id

    const alheia = await post(
      `/conversations/${idDeBob}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'inbound', body: 'invadindo' },
    )
    const inexistente = await post(
      `/conversations/${UUID_INEXISTENTE}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'inbound', body: 'invadindo' },
    )

    expect(alheia.status).toBe(404)
    // Byte a byte: qualquer diferenca confirmaria que a conversa de B existe.
    expect(alheia.body).toBe(inexistente.body)

    // E nada foi gravado na conversa de B.
    const threadDeB = await get(
      `/conversations/${idDeBob}/messages`,
      bob.accessToken,
      bob.clinicId,
    )
    expect((threadDeB.json as { items: Message[] }).items).toEqual([])
  })

  it('sem JWT devolve 401', async () => {
    const r = await post(`/conversations/${conversa.id}/messages`, null, alice.clinicId, {
      direction: 'inbound',
      body: 'oi',
    })
    expect(r.status).toBe(401)
  })
})

/* ===========================================================================
   occurredAt
   ======================================================================== */
describe('occurredAt', () => {
  it('aceita o passado — e para isso que o modo manual existe', async () => {
    const conversa = (await criar({ contactName: 'Registro retroativo' })).conversation
    const ontem = new Date(Date.now() - 24 * 3600_000).toISOString()

    const r = await post(
      `/conversations/${conversa.id}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'inbound', body: 'Ligou ontem.', occurredAt: ontem },
    )
    expect(r.status).toBe(201)
    const resultado = r.json as RegisterManualMessageResult
    expect(new Date(resultado.message.occurredAt).getTime()).toBe(new Date(ontem).getTime())
  })

  it('recusa o futuro — a fila ordena por atividade', async () => {
    const conversa = (await criar({ contactName: 'Tentativa de furar fila' })).conversation
    const futuro = new Date(Date.now() + 3600_000).toISOString()

    const r = await post(
      `/conversations/${conversa.id}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'inbound', body: 'do futuro', occurredAt: futuro },
    )
    // last_message_at e atualizado com greatest(): um instante a frente
    // prenderia a conversa no topo da fila, e nenhuma mensagem real posterior
    // desfaria isso.
    expect(r.status).toBe(400)
  })

  it('tolera relogio do cliente adiantado alguns minutos', async () => {
    const conversa = (await criar({ contactName: 'Clock skew' })).conversation
    const poucoAFrente = new Date(Date.now() + 60_000).toISOString()

    const r = await post(
      `/conversations/${conversa.id}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'outbound', body: 'um minuto a frente', occurredAt: poucoAFrente },
    )
    expect(r.status).toBe(201)
  })

  it('omitido usa o relogio do SERVIDOR', async () => {
    const conversa = (await criar({ contactName: 'Sem occurredAt' })).conversation
    const antes = Date.now()

    const r = await post(
      `/conversations/${conversa.id}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'inbound', body: 'agora' },
    )
    const resultado = r.json as RegisterManualMessageResult
    const t = new Date(resultado.message.occurredAt).getTime()
    expect(t).toBeGreaterThanOrEqual(antes - 5000)
    expect(t).toBeLessThanOrEqual(Date.now() + 5000)
  })
})

/* ===========================================================================
   Reabertura automatica
   ======================================================================== */
describe('conversa resolvida que recebe inbound', () => {
  it('reabre, e a reabertura NAO e atribuida a quem registrou', async () => {
    const conversa = (await criar({ contactName: 'Voltou a falar' })).conversation

    await alice.db.rpc('conversation_set_status', {
      p_conversation_id: conversa.id,
      p_expected_version: conversa.version,
      p_status: 'resolved',
    })

    const r = await post(
      `/conversations/${conversa.id}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'inbound', body: 'Oi, voltei.' },
    )
    expect(r.status).toBe(201)
    const resultado = r.json as RegisterManualMessageResult

    // 1. O status voltou, e a resposta ja carrega isso.
    expect(resultado.conversation.status).toBe('open')

    // 2. A mensagem continua registrada por quem a digitou.
    expect(resultado.message.recordedByUserId).toBe(alice.userId)

    // 3. Mas a REABERTURA e do sistema. Alice decidiu registrar uma mensagem,
    //    nao decidiu reabrir o atendimento — atribuir a ela poria na auditoria
    //    uma decisao que ela nunca tomou.
    const eventos = await get(
      `/conversations/${conversa.id}/events?limit=100`,
      alice.accessToken,
      alice.clinicId,
    )
    const page = eventos.json as {
      items: {
        eventType: string
        actorNameSnapshot: string | null
        metadata: { reason?: string; from?: string; to?: string }
      }[]
    }
    const reabertura = page.items.filter((e) => e.metadata.reason === 'inbound_message')
    expect(reabertura).toHaveLength(1)
    expect(reabertura[0]!.actorNameSnapshot).toBeNull()
    expect(reabertura[0]!.metadata).toMatchObject({ from: 'resolved', to: 'open' })
  })

  it('mensagem sozinha nao mexe na versao da conversa', async () => {
    const conversa = (await criar({ contactName: 'Versao estavel' })).conversation

    const r = await post(
      `/conversations/${conversa.id}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'inbound', body: 'oi' },
    )
    const resultado = r.json as RegisterManualMessageResult

    // Se toda mensagem recebida subisse a versao, o botao que a atendente tem
    // na tela levaria 409 sem ela ter feito nada errado.
    expect(resultado.conversation.version).toBe(conversa.version)
  })

  it('outbound NAO reabre uma conversa resolvida', async () => {
    const conversa = (await criar({ contactName: 'Encerrada de vez' })).conversation
    await alice.db.rpc('conversation_set_status', {
      p_conversation_id: conversa.id,
      p_expected_version: conversa.version,
      p_status: 'resolved',
    })

    const r = await post(
      `/conversations/${conversa.id}/messages`,
      alice.accessToken,
      alice.clinicId,
      { direction: 'outbound', body: 'registro tardio do que eu disse' },
    )
    const resultado = r.json as RegisterManualMessageResult
    // Quem reabre e o paciente voltando a falar, nao a clinica anotando algo.
    expect(resultado.conversation.status).toBe('resolved')
  })
})
