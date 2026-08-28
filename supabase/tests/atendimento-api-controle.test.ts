/**
 * =============================================================================
 * ATENDIMENTO — CONTROLE E CONCORRENCIA (BLOCO 3), PELO HTTP DE VERDADE
 * =============================================================================
 *
 * O que este arquivo prova, e que nenhum outro prova:
 *
 *   - duas pessoas agindo AO MESMO TEMPO sobre a mesma conversa;
 *   - que exatamente uma vence, e a outra recebe 409 com o estado atual;
 *   - que nao sobra evento orfao nem estado intermediario impossivel.
 *
 * As corridas usam Promise.all sobre requisicoes ja preparadas, disparadas sem
 * await entre elas. Serializar deliberadamente (uma, depois a outra) testaria
 * outra coisa: provaria a checagem de versao, mas nunca a corrida.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  ClinicMemberSummary,
  Conversation,
  ConversationConflictResponse,
} from '@clinicas/shared'
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

/** Clinica A: Maria (dona) e Joao (atendente). Sao os dois lados da corrida. */
let maria: TestActor
let joao: { userId: string; accessToken: string; db: SupabaseClient }
/** Clinica B, para o isolamento continuar provado. */
let bruno: TestActor

interface Resposta {
  status: number
  body: string
  json: unknown
}

async function req(
  metodo: string,
  path: string,
  token: string | null,
  clinicId: string | null,
  payload?: unknown,
): Promise<Resposta> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (clinicId) headers['x-clinic-id'] = clinicId

  const response = await fetch(`${env.apiUrl}/api${path}`, {
    method: metodo,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
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

const comoMaria = (m: string, p: string, payload?: unknown) =>
  req(m, p, maria.accessToken, maria.clinicId, payload)
const comoJoao = (m: string, p: string, payload?: unknown) =>
  req(m, p, joao.accessToken, maria.clinicId, payload)

/** Conversa nova, sem dono, para cada teste comecar de um estado conhecido. */
async function novaConversa(nome: string): Promise<Conversation> {
  const r = await comoMaria('POST', '/conversations', { contactName: nome })
  expect(r.status, r.body.slice(0, 200)).toBe(201)
  return (r.json as { conversation: Conversation }).conversation
}

async function eventosDe(conversationId: string) {
  const { data } = await admin
    .from('conversation_events')
    .select('event_type, actor_user_id, metadata, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  return data ?? []
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)

  const saude = await fetch(`${env.apiUrl}/api/health`).catch(() => null)
  if (saude?.ok !== true) {
    throw new Error(`API precisa estar no ar em ${env.apiUrl} para estes testes.`)
  }

  maria = await createActor(env, admin, registry, 'ctrl-maria')
  bruno = await createActor(env, admin, registry, 'ctrl-bruno')

  const email = `ctrl-joao-${registry.testRunId}@example.test`
  const password = `Senha-Teste-${registry.testRunId}!`
  const { data: criado, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Usuario JOAO', test_run_id: registry.testRunId },
  })
  if (error || !criado.user) throw new Error(`joao: ${error?.message}`)
  registry.registerUser(criado.user.id)
  await admin
    .from('clinic_members')
    .insert({ clinic_id: maria.clinicId, user_id: criado.user.id, role: 'attendant' })

  const db = createAnonClient(env)
  const { data: sessao } = await db.auth.signInWithPassword({ email, password })
  joao = { userId: criado.user.id, accessToken: sessao!.session!.access_token, db }
}, 240_000)

afterAll(async () => {
  if (registry) await registry.cleanup(admin)
}, 120_000)

/* ===========================================================================
   A CORRIDA — o teste principal do bloco
   ======================================================================== */
describe('dois atendentes, mesma versao', () => {
  it('assign concorrente: exatamente um vence', async () => {
    const c = await novaConversa('Corrida de assign')

    // Disparadas sem await entre elas: as duas saem com a MESMA versao N.
    const [rMaria, rJoao] = await Promise.all([
      comoMaria('POST', `/conversations/${c.id}/assign`, { expectedVersion: c.version }),
      comoJoao('POST', `/conversations/${c.id}/assign`, { expectedVersion: c.version }),
    ])

    const status = [rMaria.status, rJoao.status].sort()
    expect(status, `${rMaria.status}/${rJoao.status}`).toEqual([200, 409])

    const vencedora = rMaria.status === 200 ? rMaria : rJoao
    const perdedora = rMaria.status === 200 ? rJoao : rMaria
    const donoEsperado = rMaria.status === 200 ? maria.userId : joao.userId

    // 1. A vencedora recebe a conversa com ela mesma como responsavel.
    const ganha = vencedora.json as Conversation
    expect(ganha.assignedTo).toBe(donoEsperado)
    expect(ganha.version).toBe(c.version + 1)

    // 2. A perdedora recebe o contrato de conflito, com o estado ATUAL.
    const conflito = perdedora.json as ConversationConflictResponse
    expect(conflito.error).toBe('conversation_conflict')
    expect(conflito.conversation.assignedTo).toBe(donoEsperado)
    expect(conflito.conversation.version).toBe(c.version + 1)
    // Sem SQL, sem nome de constraint, sem dado de outra entidade.
    expect(perdedora.body).not.toMatch(/select |update |constraint|pg_|postgres/i)

    // 3. No banco ha UM dono e UM evento de assign — nao duas vitorias.
    const { data: final } = await admin
      .from('conversations')
      .select('assigned_to, version')
      .eq('id', c.id)
      .single()
    expect(final!.assigned_to).toBe(donoEsperado)
    expect(final!.version).toBe(c.version + 1)

    const assigns = (await eventosDe(c.id)).filter((e) => e.event_type === 'assigned')
    expect(assigns).toHaveLength(1)
    expect(assigns[0]!.actor_user_id).toBe(donoEsperado)
  })

  it('transferir e liberar ao mesmo tempo: so um efeito sobrevive', async () => {
    const c = await novaConversa('Corrida transfer x release')
    const assumida = await comoMaria('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })
    const versao = (assumida.json as Conversation).version

    const [rTransfer, rRelease] = await Promise.all([
      comoMaria('POST', `/conversations/${c.id}/transfer`, {
        expectedVersion: versao,
        assigneeUserId: joao.userId,
      }),
      comoMaria('POST', `/conversations/${c.id}/release`, { expectedVersion: versao }),
    ])

    expect([rTransfer.status, rRelease.status].sort()).toEqual([200, 409])

    const { data: final } = await admin
      .from('conversations')
      .select('assigned_to, version')
      .eq('id', c.id)
      .single()

    // O estado final e um dos dois, nunca uma mistura.
    const tipos = (await eventosDe(c.id)).map((e) => e.event_type)
    if (rTransfer.status === 200) {
      expect(final!.assigned_to).toBe(joao.userId)
      expect(tipos).toContain('transferred')
      expect(tipos).not.toContain('released')
    } else {
      expect(final!.assigned_to).toBeNull()
      expect(tipos).toContain('released')
      expect(tipos).not.toContain('transferred')
    }
    expect(final!.version).toBe(versao + 1)
  })

  it('dois status diferentes ao mesmo tempo: nao ha last-write-wins', async () => {
    const c = await novaConversa('Corrida de status')

    const [rA, rB] = await Promise.all([
      comoMaria('PATCH', `/conversations/${c.id}/status`, {
        expectedVersion: c.version,
        status: 'waiting_patient',
      }),
      comoJoao('PATCH', `/conversations/${c.id}/status`, {
        expectedVersion: c.version,
        status: 'resolved',
      }),
    ])

    expect([rA.status, rB.status].sort()).toEqual([200, 409])
    const esperado = rA.status === 200 ? 'waiting_patient' : 'resolved'

    const { data: final } = await admin
      .from('conversations')
      .select('status, version')
      .eq('id', c.id)
      .single()
    expect(final!.status).toBe(esperado)
    expect(final!.version).toBe(c.version + 1)

    // Um unico status_changed: a perdedora nao gravou nada.
    const mudancas = (await eventosDe(c.id)).filter((e) => e.event_type === 'status_changed')
    expect(mudancas).toHaveLength(1)
    expect(mudancas[0]!.metadata).toMatchObject({ from: 'open', to: esperado })
  })

  it('dois vinculos de paciente ao mesmo tempo: um so sobrescreve', async () => {
    const c = await novaConversa('Corrida de vinculo')
    const { data: outro } = await maria.db
      .from('patients')
      .insert({ clinic_id: maria.clinicId, name: 'Segundo Paciente', phone: '11955554444' })
      .select('id')
      .single()

    const [rA, rB] = await Promise.all([
      comoMaria('POST', `/conversations/${c.id}/patient`, {
        expectedVersion: c.version,
        patientId: maria.patientId,
      }),
      comoJoao('POST', `/conversations/${c.id}/patient`, {
        expectedVersion: c.version,
        patientId: outro!.id as string,
      }),
    ])

    expect([rA.status, rB.status].sort()).toEqual([200, 409])
    const esperado = rA.status === 200 ? maria.patientId : (outro!.id as string)

    const { data: final } = await admin
      .from('conversations')
      .select('patient_id, version')
      .eq('id', c.id)
      .single()
    expect(final!.patient_id).toBe(esperado)
    expect(final!.version).toBe(c.version + 1)

    const vinculos = (await eventosDe(c.id)).filter((e) => e.event_type === 'patient_linked')
    expect(vinculos).toHaveLength(1)
  })
})

/* ===========================================================================
   404 x 409 — os dois it.todo que faltavam
   ======================================================================== */
describe('404 x 409', () => {
  it('versao stale na PROPRIA clinica devolve 409 com o estado atual', async () => {
    const c = await novaConversa('Stale')
    await comoMaria('POST', `/conversations/${c.id}/assign`, { expectedVersion: c.version })

    // Segunda tentativa com a versao velha.
    const r = await comoJoao('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })
    expect(r.status).toBe(409)
    const corpo = r.json as ConversationConflictResponse
    expect(corpo.error).toBe('conversation_conflict')
    expect(corpo.conversation.id).toBe(c.id)
    expect(corpo.conversation.assignedTo).toBe(maria.userId)
  })

  it('UUID inexistente e conversa de outra clinica dao 404 IDENTICO', async () => {
    const deBruno = await req('POST', '/conversations', bruno.accessToken, bruno.clinicId, {
      contactName: 'Conversa de B',
    })
    const idDeBruno = (deBruno.json as { conversation: Conversation }).conversation.id

    const alheia = await comoMaria('POST', `/conversations/${idDeBruno}/assign`, {
      expectedVersion: 1,
    })
    const inexistente = await comoMaria('POST', `/conversations/${UUID_INEXISTENTE}/assign`, {
      expectedVersion: 1,
    })

    expect(alheia.status).toBe(404)
    // Byte a byte: distinguir os dois ja seria confirmar que a de Bruno existe.
    expect(alheia.body).toBe(inexistente.body)
    // E nada foi alterado na conversa de Bruno.
    const { data: intacta } = await admin
      .from('conversations')
      .select('assigned_to')
      .eq('id', idDeBruno)
      .single()
    expect(intacta!.assigned_to).toBeNull()
  })

  it('membership removido no meio da corrida NAO recebe 409 com estado', async () => {
    const c = await novaConversa('Vinculo perdido')
    // Maria assume, entao a versao de Joao fica stale — seria 409.
    await comoMaria('POST', `/conversations/${c.id}/assign`, { expectedVersion: c.version })

    await admin
      .from('clinic_members')
      .delete()
      .eq('clinic_id', maria.clinicId)
      .eq('user_id', joao.userId)

    const r = await comoJoao('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })

    // O guard barra antes; e mesmo se nao barrasse, `conversation_conflict`
    // revalida o membership e devolve not_found. O 409 nao pode virar canal de
    // vazamento para quem acabou de perder o acesso.
    expect([403, 404]).toContain(r.status)
    expect(r.body).not.toContain(c.id)
    expect(r.body).not.toContain(maria.userId)

    await admin
      .from('clinic_members')
      .insert({ clinic_id: maria.clinicId, user_id: joao.userId, role: 'attendant' })
  })
})

/* ===========================================================================
   Semantica de cada operacao
   ======================================================================== */
describe('operacoes de controle', () => {
  it('assign atribui a QUEM CHAMA — nao ha como escolher outra pessoa', async () => {
    const c = await novaConversa('Assign e sempre para si')

    // Mandar um userId no corpo e recusado pelo schema estrito.
    const forjado = await comoMaria('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
      userId: joao.userId,
      assigneeUserId: joao.userId,
    })
    expect(forjado.status).toBe(400)

    const r = await comoJoao('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })
    expect(r.status).toBe(200)
    // Joao chamou, Joao ficou com a conversa.
    expect((r.json as Conversation).assignedTo).toBe(joao.userId)
  })

  it('transfer troca o dono e registra transferred', async () => {
    const c = await novaConversa('Transferencia')
    const assumida = await comoMaria('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })

    const r = await comoMaria('POST', `/conversations/${c.id}/transfer`, {
      expectedVersion: (assumida.json as Conversation).version,
      assigneeUserId: joao.userId,
    })
    expect(r.status).toBe(200)
    expect((r.json as Conversation).assignedTo).toBe(joao.userId)

    const eventos = await eventosDe(c.id)
    const transferido = eventos.find((e) => e.event_type === 'transferred')!
    expect(transferido.metadata).toMatchObject({
      from_user_id: maria.userId,
      to_user_id: joao.userId,
    })
  })

  it('transfer para alguem de fora nao revela existencia da conta', async () => {
    const c = await novaConversa('Transfer invalida')
    const assumida = await comoMaria('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })
    const versao = (assumida.json as Conversation).version

    for (const alvo of [bruno.userId, UUID_INEXISTENTE]) {
      const r = await comoMaria('POST', `/conversations/${c.id}/transfer`, {
        expectedVersion: versao,
        assigneeUserId: alvo,
      })
      expect(r.status).toBe(400)
      // Mesma mensagem para "nao existe" e "e de outra clinica": distinguir ja
      // seria informacao sobre a conta.
      expect(JSON.parse(r.body).message).toBe('Responsavel invalido para esta clinica.')
      expect(r.body).not.toContain(bruno.clinicId)
      expect(r.body).not.toContain('ctrl-bruno')
    }
  })

  it('release devolve a conversa a fila', async () => {
    const c = await novaConversa('Release')
    const assumida = await comoMaria('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })

    const r = await comoMaria('POST', `/conversations/${c.id}/release`, {
      expectedVersion: (assumida.json as Conversation).version,
    })
    expect(r.status).toBe(200)
    expect((r.json as Conversation).assignedTo).toBeNull()
    expect((await eventosDe(c.id)).map((e) => e.event_type)).toContain('released')
  })

  it('release de conversa que ja esta na fila e conflito', async () => {
    const c = await novaConversa('Release sem dono')
    const r = await comoMaria('POST', `/conversations/${c.id}/release`, {
      expectedVersion: c.version,
    })
    // A pre-condicao da RPC e `assigned_to is not null`. Sem dono, nao ha o que
    // liberar — e o cliente precisa do estado atual para se corrigir.
    expect(r.status).toBe(409)
    expect((r.json as ConversationConflictResponse).conversation.assignedTo).toBeNull()
  })

  it('status segue a maquina de estados do BANCO', async () => {
    const c = await novaConversa('Maquina de estados')

    const paraAguardando = await comoMaria('PATCH', `/conversations/${c.id}/status`, {
      expectedVersion: c.version,
      status: 'waiting_patient',
    })
    expect(paraAguardando.status).toBe(200)

    // waiting_patient -> resolved e permitido.
    const paraResolvida = await comoMaria('PATCH', `/conversations/${c.id}/status`, {
      expectedVersion: (paraAguardando.json as Conversation).version,
      status: 'resolved',
    })
    expect(paraResolvida.status).toBe(200)

    // resolved -> waiting_patient NAO e: reabrir devolve a fila da clinica, e
    // so de la a conversa volta a esperar o paciente.
    const invalida = await comoMaria('PATCH', `/conversations/${c.id}/status`, {
      expectedVersion: (paraResolvida.json as Conversation).version,
      status: 'waiting_patient',
    })
    expect(invalida.status).toBe(400)
    // A regra veio do banco; a mensagem nao vaza SQL.
    expect(invalida.body).not.toMatch(/INVALID_STATUS_TRANSITION|22023|pg_|select /i)
  })

  it('status igual ao atual nao fabrica evento nem versao', async () => {
    const c = await novaConversa('No-op de status')
    expect(c.status).toBe('open')

    const r = await comoMaria('PATCH', `/conversations/${c.id}/status`, {
      expectedVersion: c.version,
      status: 'open',
    })
    expect(r.status).toBe(200)

    // O banco trata como no-op: sem evento e sem incremento. A API nao inventa
    // nem uma coisa nem outra.
    const atual = r.json as Conversation
    expect(atual.version).toBe(c.version)
    expect((await eventosDe(c.id)).filter((e) => e.event_type === 'status_changed')).toHaveLength(0)
  })

  it('vincular paciente diferente e RECUSADO — troca exige acao explicita', async () => {
    const c = await novaConversa('Sem substituicao silenciosa')
    const { data: outro } = await maria.db
      .from('patients')
      .insert({ clinic_id: maria.clinicId, name: 'Paciente Alternativo', phone: '11944443333' })
      .select('id')
      .single()

    const ligada = await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: c.version,
      patientId: maria.patientId,
    })
    const versao = (ligada.json as Conversation).version

    const tentativa = await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: versao,
      patientId: outro!.id as string,
    })

    // 409, mas com codigo PROPRIO: conflito de versao pede "recarregue"; este
    // pede uma acao do usuario — desvincular antes.
    expect(tentativa.status).toBe(409)
    const corpo = tentativa.json as { error: string; message: string; conversation: Conversation }
    expect(corpo.error).toBe('conversation_patient_already_linked')
    expect(corpo.message).toContain('Desvincule o paciente atual')
    expect(corpo.conversation.patientId).toBe(maria.patientId)

    // O paciente antigo permanece intacto e a versao nao andou.
    const { data: final } = await admin
      .from('conversations')
      .select('patient_id, version')
      .eq('id', c.id)
      .single()
    expect(final!.patient_id).toBe(maria.patientId)
    expect(final!.version).toBe(versao)

    // E a recusa nao deixou evento nenhum.
    const vinculos = (await eventosDe(c.id)).filter((e) => e.event_type === 'patient_linked')
    expect(vinculos).toHaveLength(1)

    // Nada sobre o paciente solicitado sai na resposta.
    expect(tentativa.body).not.toContain(outro!.id as string)
    expect(tentativa.body).not.toContain('Paciente Alternativo')
  })

  it('vincular o MESMO paciente de novo e no-op bem sucedido', async () => {
    const c = await novaConversa('No-op de vinculo')
    const ligada = await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: c.version,
      patientId: maria.patientId,
    })
    const versao = (ligada.json as Conversation).version
    const eventosAntes = (await eventosDe(c.id)).length

    const repetida = await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: versao,
      patientId: maria.patientId,
    })

    // Repetir a mesma operacao nao e erro — e tambem nao e fato novo.
    expect(repetida.status).toBe(200)
    const atual = repetida.json as Conversation
    expect(atual.patientId).toBe(maria.patientId)
    expect(atual.version).toBe(versao)
    expect((await eventosDe(c.id)).length).toBe(eventosAntes)
  })

  it('trocar de paciente: desvincular, depois vincular', async () => {
    const c = await novaConversa('Troca explicita')
    const { data: outro } = await maria.db
      .from('patients')
      .insert({ clinic_id: maria.clinicId, name: 'Paciente Correto', phone: '11933332222' })
      .select('id')
      .single()

    const ligada = await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: c.version,
      patientId: maria.patientId,
    })
    const solta = await comoMaria(
      'DELETE',
      `/conversations/${c.id}/patient?expectedVersion=${(ligada.json as Conversation).version}`,
    )
    const religada = await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: (solta.json as Conversation).version,
      patientId: outro!.id as string,
    })

    expect(religada.status).toBe(200)
    expect((religada.json as Conversation).patientId).toBe(outro!.id)

    // O historico conta o que realmente aconteceu: duas acoes, dois eventos.
    expect((await eventosDe(c.id)).map((e) => e.event_type)).toEqual([
      'conversation_created',
      'patient_linked',
      'patient_unlinked',
      'patient_linked',
    ])
  })

  it('versao stale tem precedencia sobre a regra de vinculo', async () => {
    const c = await novaConversa('Stale vence already_linked')
    const { data: outro } = await maria.db
      .from('patients')
      .insert({ clinic_id: maria.clinicId, name: 'Paciente da corrida', phone: '11922221111' })
      .select('id')
      .single()

    const versaoLida = c.version
    await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: versaoLida,
      patientId: maria.patientId,
    })

    // Joao ainda esta na versao antiga. Precisa receber CONFLITO de versao, e
    // nao "ja vinculado": ele raciocina sobre um estado que ja mudou, e a
    // resposta certa e o estado atual, nao uma instrucao para desvincular.
    const stale = await comoJoao('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: versaoLida,
      patientId: outro!.id as string,
    })
    expect(stale.status).toBe(409)
    expect((stale.json as { error: string }).error).toBe('conversation_conflict')
  })

  it('vincular e desvincular paciente geram os dois eventos', async () => {
    const c = await novaConversa('Vinculo')

    const ligada = await comoMaria('POST', `/conversations/${c.id}/patient`, {
      expectedVersion: c.version,
      patientId: maria.patientId,
    })
    expect(ligada.status).toBe(200)
    expect((ligada.json as Conversation).patientId).toBe(maria.patientId)

    const versao = (ligada.json as Conversation).version
    const solta = await comoMaria(
      'DELETE',
      `/conversations/${c.id}/patient?expectedVersion=${versao}`,
    )
    expect(solta.status).toBe(200)
    expect((solta.json as Conversation).patientId).toBeNull()

    expect((await eventosDe(c.id)).map((e) => e.event_type)).toEqual([
      'conversation_created',
      'patient_linked',
      'patient_unlinked',
    ])
  })

  it('paciente de outra clinica nao revela existencia', async () => {
    const c = await novaConversa('Paciente alheio')
    for (const alvo of [bruno.patientId, UUID_INEXISTENTE]) {
      const r = await comoMaria('POST', `/conversations/${c.id}/patient`, {
        expectedVersion: c.version,
        patientId: alvo,
      })
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body).message).toBe('Paciente invalido para esta clinica.')
      expect(r.body).not.toContain(bruno.patientName)
    }
  })
})

/* ===========================================================================
   Contrato de entrada
   ======================================================================== */
describe('validacao das entradas de controle', () => {
  let c: Conversation

  beforeAll(async () => {
    c = await novaConversa('Validacao')
  })

  it('expectedVersion ausente ou invalido devolve 400', async () => {
    const casos: unknown[] = [{}, { expectedVersion: 0 }, { expectedVersion: -1 }, { expectedVersion: 1.5 }, { expectedVersion: 'um' }, { expectedVersion: null }]
    for (const caso of casos) {
      const r = await comoMaria('POST', `/conversations/${c.id}/assign`, caso)
      expect(r.status, JSON.stringify(caso)).toBe(400)
    }
  })

  it('campo desconhecido devolve 400 — nao e descartado', async () => {
    for (const extra of [{ clinicId: bruno.clinicId }, { version: 1 }, { status: 'resolved' }]) {
      const r = await comoMaria('POST', `/conversations/${c.id}/assign`, {
        expectedVersion: c.version,
        ...extra,
      })
      expect(r.status, JSON.stringify(extra)).toBe(400)
    }
  })

  it('status fora do enum devolve 400', async () => {
    for (const status of ['new', 'waiting_clinic', 'fechada', '']) {
      const r = await comoMaria('PATCH', `/conversations/${c.id}/status`, {
        expectedVersion: c.version,
        status,
      })
      expect(r.status, status).toBe(400)
    }
  })

  it('desvincular sem expectedVersion na query devolve 400', async () => {
    const r = await comoMaria('DELETE', `/conversations/${c.id}/patient`)
    expect(r.status).toBe(400)
  })

  it('sem JWT devolve 401 em todas as rotas de controle', async () => {
    const rotas: [string, string, unknown][] = [
      ['POST', `/conversations/${c.id}/assign`, { expectedVersion: 1 }],
      ['POST', `/conversations/${c.id}/transfer`, { expectedVersion: 1, assigneeUserId: UUID_INEXISTENTE }],
      ['POST', `/conversations/${c.id}/release`, { expectedVersion: 1 }],
      ['PATCH', `/conversations/${c.id}/status`, { expectedVersion: 1, status: 'resolved' }],
      ['POST', `/conversations/${c.id}/patient`, { expectedVersion: 1, patientId: UUID_INEXISTENTE }],
      ['DELETE', `/conversations/${c.id}/patient?expectedVersion=1`, undefined],
    ]
    for (const [metodo, rota, payload] of rotas) {
      const r = await req(metodo, rota, null, maria.clinicId, payload)
      expect(r.status, rota).toBe(401)
    }
  })

  it('sem header de clinica devolve 403', async () => {
    const r = await req('POST', `/conversations/${c.id}/assign`, maria.accessToken, null, {
      expectedVersion: c.version,
    })
    expect(r.status).toBe(403)
  })
})

/* ===========================================================================
   Diretorio da equipe pela API
   ======================================================================== */
describe('GET /clinics/members', () => {
  it('devolve a equipe da clinica ativa com tres campos', async () => {
    const r = await comoMaria('GET', '/clinics/members')
    expect(r.status).toBe(200)
    const equipe = r.json as ClinicMemberSummary[]

    expect(equipe.map((m) => m.userId).sort()).toEqual([maria.userId, joao.userId].sort())
    for (const membro of equipe) {
      expect(Object.keys(membro).sort()).toEqual(['displayName', 'role', 'userId'])
    }
    expect(equipe.find((m) => m.userId === joao.userId)?.displayName).toBe('Usuario JOAO')
  })

  it('nao vaza email nem dados de outra clinica', async () => {
    const r = await comoMaria('GET', '/clinics/members')
    expect(r.body).not.toContain('@example.test')
    expect(r.body).not.toContain(bruno.userId)
    expect(r.body).not.toContain(bruno.clinicId)
  })

  it('quem e de outra clinica nao enxerga esta equipe', async () => {
    const r = await req('GET', '/clinics/members', bruno.accessToken, maria.clinicId)
    expect(r.status).toBe(403)
  })

  it('sem JWT devolve 401', async () => {
    const r = await req('GET', '/clinics/members', null, maria.clinicId)
    expect(r.status).toBe(401)
  })

  it('serve para montar o seletor de transferencia', async () => {
    // O diretorio e a origem dos candidatos; a autorizacao real continua na FK.
    const r = await comoMaria('GET', '/clinics/members')
    const candidatos = (r.json as ClinicMemberSummary[]).filter((m) => m.userId !== maria.userId)
    expect(candidatos.length).toBeGreaterThan(0)

    const c = await novaConversa('Transferencia pelo diretorio')
    const assumida = await comoMaria('POST', `/conversations/${c.id}/assign`, {
      expectedVersion: c.version,
    })
    const transferida = await comoMaria('POST', `/conversations/${c.id}/transfer`, {
      expectedVersion: (assumida.json as Conversation).version,
      assigneeUserId: candidatos[0]!.userId,
    })
    expect(transferida.status).toBe(200)
    expect((transferida.json as Conversation).assignedTo).toBe(candidatos[0]!.userId)
  })
})
