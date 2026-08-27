import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_CHANNELS,
  CONVERSATION_CHANNEL_LABELS,
  CONVERSATION_EVENT_LABELS,
  CONVERSATION_EVENT_TYPES,
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_LABELS,
  CONVERSATION_STATUS_TRANSITIONS,
  MESSAGE_DIRECTIONS,
  MESSAGE_DIRECTION_LABELS,
  registerManualMessageSchema,
  assignConversationSchema,
  canTransitionConversation,
  changeConversationStatusSchema,
  registerConversationSchema,
  isUnclaimed,
  isValidChannelProviderPair,
  needsReply,
  phoneE164Schema,
  toE164BR,
  transferConversationSchema,
  type ConversationStatus,
} from './conversation'

describe('transicoes de status', () => {
  it('nenhum estado e terminal — conversa sempre pode voltar', () => {
    for (const status of CONVERSATION_STATUSES) {
      expect(
        CONVERSATION_STATUS_TRANSITIONS[status].length,
        `${status} nao pode ser terminal: mensagem nova sempre reabre`,
      ).toBeGreaterThan(0)
    }
  })

  it('permite o caminho do fluxo real', () => {
    expect(canTransitionConversation('open', 'waiting_patient')).toBe(true)
    expect(canTransitionConversation('open', 'resolved')).toBe(true)
    expect(canTransitionConversation('waiting_patient', 'open')).toBe(true)
    expect(canTransitionConversation('waiting_patient', 'resolved')).toBe(true)
    expect(canTransitionConversation('resolved', 'open')).toBe(true)
  })

  it('reabrir devolve a fila da clinica, nunca direto para aguardando paciente', () => {
    expect(canTransitionConversation('resolved', 'waiting_patient')).toBe(false)
  })

  it('nao permite transicao para o proprio estado', () => {
    for (const status of CONVERSATION_STATUSES) {
      expect(canTransitionConversation(status, status)).toBe(false)
    }
  })

  it('so referencia estados que existem', () => {
    const validos = new Set<string>(CONVERSATION_STATUSES)
    for (const [from, alvos] of Object.entries(CONVERSATION_STATUS_TRANSITIONS)) {
      expect(validos.has(from)).toBe(true)
      for (const to of alvos) expect(validos.has(to)).toBe(true)
    }
  })
})

describe('rotulos em pt-BR', () => {
  // Quebra quando alguem adiciona um valor ao enum e esquece o rotulo.
  it('todo status tem rotulo', () => {
    for (const s of CONVERSATION_STATUSES) {
      expect(CONVERSATION_STATUS_LABELS[s]?.length).toBeGreaterThan(0)
    }
    expect(Object.keys(CONVERSATION_STATUS_LABELS)).toHaveLength(CONVERSATION_STATUSES.length)
  })

  it('todo tipo de evento tem rotulo', () => {
    for (const e of CONVERSATION_EVENT_TYPES) {
      expect(CONVERSATION_EVENT_LABELS[e]?.length).toBeGreaterThan(0)
    }
    expect(Object.keys(CONVERSATION_EVENT_LABELS)).toHaveLength(CONVERSATION_EVENT_TYPES.length)
  })

  it('todo canal e direcao tem rotulo', () => {
    for (const c of CONVERSATION_CHANNELS) {
      expect(CONVERSATION_CHANNEL_LABELS[c]?.length).toBeGreaterThan(0)
    }
    for (const d of MESSAGE_DIRECTIONS) {
      expect(MESSAGE_DIRECTION_LABELS[d]?.length).toBeGreaterThan(0)
    }
  })

  it('nao existem os tipos resolved e reopened — status_changed cobre os dois', () => {
    expect(CONVERSATION_EVENT_TYPES).not.toContain('resolved')
    expect(CONVERSATION_EVENT_TYPES).not.toContain('reopened')
    expect(CONVERSATION_EVENT_TYPES).toContain('status_changed')
  })
})

describe('canal x provedor', () => {
  it('manual nao tem provedor', () => {
    expect(isValidChannelProviderPair('manual', null)).toBe(true)
    expect(isValidChannelProviderPair('manual', undefined)).toBe(true)
    expect(isValidChannelProviderPair('manual', '')).toBe(true)
    expect(isValidChannelProviderPair('manual', 'evolution')).toBe(false)
  })

  it('canal externo exige provedor nao vazio', () => {
    expect(isValidChannelProviderPair('whatsapp', 'meta_cloud')).toBe(true)
    expect(isValidChannelProviderPair('whatsapp', 'evolution')).toBe(true)
    expect(isValidChannelProviderPair('whatsapp', null)).toBe(false)
    expect(isValidChannelProviderPair('whatsapp', '')).toBe(false)
    // So espaco em branco nao e provedor.
    expect(isValidChannelProviderPair('whatsapp', '   ')).toBe(false)
    expect(isValidChannelProviderPair('whatsapp', 'x')).toBe(false)
  })
})

describe('telefone E.164', () => {
  it('aceita numero internacional bem formado', () => {
    expect(phoneE164Schema.safeParse('+5511987654321').success).toBe(true)
    expect(phoneE164Schema.safeParse('+351912345678').success).toBe(true)
  })

  it('recusa o que nao e E.164', () => {
    for (const ruim of [
      '11987654321', // sem +
      '+0511987654321', // pais comecando com zero
      '+55 11 98765-4321', // com mascara
      '+551', // curto demais
      `+${'9'.repeat(16)}`, // longo demais
      '',
    ]) {
      expect(phoneE164Schema.safeParse(ruim).success, ruim).toBe(false)
    }
  })

  it('converte mascara brasileira para E.164', () => {
    expect(toE164BR('(11) 98765-4321')).toBe('+5511987654321')
    expect(toE164BR('11 3456-7890')).toBe('+551134567890')
    expect(toE164BR('+55 (11) 98765-4321')).toBe('+5511987654321')
  })

  it('devolve null quando nao da para ter certeza', () => {
    // Chutar aqui faria duas pessoas compartilharem a mesma thread.
    expect(toE164BR('98765')).toBeNull()
    expect(toE164BR('')).toBeNull()
    expect(toE164BR('abc')).toBeNull()
  })

  it('nao transforma numero estrangeiro em brasileiro', () => {
    /*
     * Regressao: '+1 415 555 0100' perde o '+', vira 11 digitos e caia na regra
     * de celular brasileiro, saindo como '+5514155550100'. Como o telefone e a
     * identidade da thread, isso colocaria duas pessoas na mesma conversa.
     */
    expect(toE164BR('+1 415 555 0100')).toBeNull()
    expect(toE164BR('+351 912 345 678')).toBeNull()
    expect(toE164BR('+44 20 7946 0958')).toBeNull()
  })

  it('aceita quando o proprio numero declara ser do Brasil', () => {
    expect(toE164BR('+55 (11) 98765-4321')).toBe('+5511987654321')
    expect(toE164BR('+55 11 3456-7890')).toBe('+551134567890')
  })

  it('o que toE164BR produz e sempre aceito pelo schema', () => {
    for (const entrada of ['(11) 98765-4321', '1134567890', '5511987654321']) {
      const convertido = toE164BR(entrada)
      expect(convertido).not.toBeNull()
      expect(phoneE164Schema.safeParse(convertido).success, entrada).toBe(true)
    }
  })
})

describe('sinais derivados', () => {
  it('precisa de resposta quando o paciente falou por ultimo', () => {
    expect(
      needsReply({ lastInboundAt: '2026-08-28T14:30:00Z', lastOutboundAt: '2026-08-28T14:00:00Z' }),
    ).toBe(true)
  })

  it('nao precisa quando a clinica ja respondeu depois', () => {
    expect(
      needsReply({ lastInboundAt: '2026-08-28T14:00:00Z', lastOutboundAt: '2026-08-28T14:30:00Z' }),
    ).toBe(false)
  })

  it('precisa quando o paciente falou e ninguem nunca respondeu', () => {
    expect(needsReply({ lastInboundAt: '2026-08-28T14:00:00Z', lastOutboundAt: null })).toBe(true)
  })

  it('nao precisa quando o paciente nunca falou', () => {
    expect(needsReply({ lastInboundAt: null, lastOutboundAt: null })).toBe(false)
    expect(needsReply({ lastInboundAt: null, lastOutboundAt: '2026-08-28T14:00:00Z' })).toBe(false)
  })

  it('"nova" e derivada de status + responsavel, nunca guardada', () => {
    expect(isUnclaimed({ status: 'open', assignedTo: null })).toBe(true)
    expect(isUnclaimed({ status: 'open', assignedTo: 'u1' })).toBe(false)
    expect(isUnclaimed({ status: 'waiting_patient', assignedTo: null })).toBe(false)
    expect(isUnclaimed({ status: 'resolved', assignedTo: null })).toBe(false)
  })
})

describe('schemas de entrada', () => {
  const UUID = '3f2a9c1e-7b64-4d2f-9a1e-52c8d0b7e441'

  it('conversa manual pode nascer sem nada preenchido', () => {
    // Os tres campos sao opcionais: uma atendente pode abrir a conversa antes
    // de saber quem e a pessoa do outro lado.
    expect(registerConversationSchema.safeParse({}).success).toBe(true)
  })

  it('channel NAO e aceito — o canal nao e escolha do cliente', () => {
    // Recusa em vez de descarte silencioso: quem manda 'whatsapp' acredita ter
    // criado uma conversa de WhatsApp, e receber 201 com uma conversa manual
    // esconderia o mal-entendido ate alguem notar que nada foi enviado.
    expect(registerConversationSchema.safeParse({ channel: 'manual' }).success).toBe(false)
    expect(registerConversationSchema.safeParse({ channel: 'whatsapp' }).success).toBe(false)
  })

  it('nenhum campo de controle passa', () => {
    for (const campo of [
      { provider: 'evolution' },
      { status: 'resolved' },
      { assignedTo: UUID },
      { version: 9 },
      { createdAt: '2020-01-01T00:00:00.000Z' },
      { clinicId: UUID },
    ]) {
      expect(registerConversationSchema.safeParse(campo).success, JSON.stringify(campo)).toBe(false)
    }
  })

  it('telefone entra CRU — a normalizacao e responsabilidade de toE164BR', () => {
    // O schema so limita tamanho. Converter aqui criaria uma segunda regra de
    // normalizacao, e duas regras divergem.
    const r = registerConversationSchema.safeParse({ contactPhone: '(11) 98765-4321' })
    expect(r.success).toBe(true)
  })

  it('mensagem exige corpo dentro do limite', () => {
    expect(registerManualMessageSchema.safeParse({ direction: 'inbound', body: 'oi' }).success).toBe(true)
    expect(registerManualMessageSchema.safeParse({ direction: 'inbound', body: '' }).success).toBe(false)
    expect(registerManualMessageSchema.safeParse({ direction: 'inbound', body: '   ' }).success).toBe(false)
    expect(
      registerManualMessageSchema.safeParse({ direction: 'inbound', body: 'x'.repeat(4097) }).success,
    ).toBe(false)
  })

  it('mensagem recusa direcao invalida', () => {
    expect(registerManualMessageSchema.safeParse({ direction: 'sideways', body: 'oi' }).success).toBe(false)
  })

  it('toda mutacao de controle exige versao', () => {
    expect(assignConversationSchema.safeParse({}).success).toBe(false)
    expect(assignConversationSchema.safeParse({ version: 3 }).success).toBe(true)
    expect(assignConversationSchema.safeParse({ version: 0 }).success).toBe(false)
    expect(assignConversationSchema.safeParse({ version: -1 }).success).toBe(false)
    expect(assignConversationSchema.safeParse({ version: 1.5 }).success).toBe(false)
  })

  it('transferencia exige destinatario', () => {
    expect(transferConversationSchema.safeParse({ version: 1 }).success).toBe(false)
    expect(transferConversationSchema.safeParse({ version: 1, toUserId: UUID }).success).toBe(true)
  })

  it('mudanca de status so aceita status que existe', () => {
    expect(
      changeConversationStatusSchema.safeParse({ version: 1, status: 'resolved' }).success,
    ).toBe(true)
    expect(
      changeConversationStatusSchema.safeParse({ version: 1, status: 'waiting_clinic' }).success,
    ).toBe(false)
    expect(changeConversationStatusSchema.safeParse({ version: 1, status: 'new' }).success).toBe(
      false,
    )
  })
})

describe('espelho do banco', () => {
  /*
   * Estes valores sao replicados no trigger enforce_conversation_status_transition
   * e nos enums da migration. O teste nao alcanca o banco — ele congela o lado de
   * ca para que uma mudanca aqui apareca como diff e obrigue a olhar o outro lado.
   */
  it('congela os status', () => {
    expect([...CONVERSATION_STATUSES]).toEqual(['open', 'waiting_patient', 'resolved'])
  })

  it('congela os tipos de evento', () => {
    expect([...CONVERSATION_EVENT_TYPES]).toEqual([
      'conversation_created',
      'assigned',
      'transferred',
      'released',
      'patient_linked',
      'patient_unlinked',
      'status_changed',
      'appointment_created',
    ])
  })

  it('congela o mapa de transicoes', () => {
    const esperado: Record<ConversationStatus, string[]> = {
      open: ['waiting_patient', 'resolved'],
      waiting_patient: ['open', 'resolved'],
      resolved: ['open'],
    }
    for (const [from, alvos] of Object.entries(esperado)) {
      expect([...CONVERSATION_STATUS_TRANSITIONS[from as ConversationStatus]]).toEqual(alvos)
    }
  })
})
