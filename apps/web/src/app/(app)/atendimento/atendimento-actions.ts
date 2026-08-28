'use server'

import { revalidatePath } from 'next/cache'
import {
  CONVERSATION_PATIENT_ALREADY_LINKED,
  toE164BR,
  type ClinicMemberSummary,
  type Conversation,
  type ConversationStatus,
  type Message,
  type ConversationListItem,
  type Page,
  type RegisterConversationResult,
  type RegisterManualMessageResult,
} from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'

/**
 * Resultado de toda acao de controle.
 *
 * `conflito` NAO e erro tecnico: e a caixa compartilhada funcionando. Vem com
 * a conversa atual para a tela se corrigir sozinha, sem recarregar a pagina.
 */
export type ResultadoControle =
  | { ok: true; conversation: Conversation }
  | { ok: false; motivo: 'conflito'; mensagem: string; conversation: Conversation }
  | { ok: false; motivo: 'paciente_ja_vinculado'; mensagem: string; conversation: Conversation }
  | { ok: false; motivo: 'erro'; mensagem: string }

interface CorpoConflito {
  error?: string
  message?: string
  conversation?: Conversation
}

/**
 * Traduz a resposta da API para algo que a tela sabe desenhar.
 *
 * Os dois 409 sao separados de proposito: conflito de versao pede "atualizamos,
 * confira"; paciente ja vinculado pede uma ACAO da pessoa — desvincular antes.
 * Achatar os dois num "erro" generico faria a tela oferecer a saida errada.
 */
async function executar(chamada: () => Promise<Conversation>): Promise<ResultadoControle> {
  try {
    const conversation = await chamada()
    revalidatePath('/atendimento')
    return { ok: true, conversation }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error

    const corpo = error.payload as CorpoConflito | null

    if (error.status === 409 && corpo?.conversation) {
      revalidatePath('/atendimento')
      return corpo.error === CONVERSATION_PATIENT_ALREADY_LINKED
        ? {
            ok: false,
            motivo: 'paciente_ja_vinculado',
            mensagem: corpo.message ?? 'Este atendimento já está vinculado a outro paciente.',
            conversation: corpo.conversation,
          }
        : {
            ok: false,
            motivo: 'conflito',
            mensagem: corpo.message ?? 'Este atendimento foi alterado por outra pessoa.',
            conversation: corpo.conversation,
          }
    }

    // 404 tambem cai aqui: a conversa sumiu ou nunca foi desta clinica. A fila
    // se corrige no proximo carregamento.
    return { ok: false, motivo: 'erro', mensagem: error.message }
  }
}

async function clinica(): Promise<string> {
  const { activeClinic } = await requireActiveSession()
  return activeClinic.clinicId
}

/* ===========================================================================
   Controle
   ======================================================================== */

export async function assumirAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Conversation>(`/api/conversations/${id}/assign`, {
      method: 'POST',
      body: { expectedVersion },
      clinicId,
    }),
  )
}

export async function transferirAction(
  id: string,
  expectedVersion: number,
  assigneeUserId: string,
) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Conversation>(`/api/conversations/${id}/transfer`, {
      method: 'POST',
      body: { expectedVersion, assigneeUserId },
      clinicId,
    }),
  )
}

export async function devolverAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Conversation>(`/api/conversations/${id}/release`, {
      method: 'POST',
      body: { expectedVersion },
      clinicId,
    }),
  )
}

export async function mudarStatusAction(
  id: string,
  expectedVersion: number,
  status: ConversationStatus,
) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Conversation>(`/api/conversations/${id}/status`, {
      method: 'PATCH',
      body: { expectedVersion, status },
      clinicId,
    }),
  )
}

export async function vincularPacienteAction(
  id: string,
  expectedVersion: number,
  patientId: string,
) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Conversation>(`/api/conversations/${id}/patient`, {
      method: 'POST',
      body: { expectedVersion, patientId },
      clinicId,
    }),
  )
}

export async function desvincularPacienteAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Conversation>(
      `/api/conversations/${id}/patient?expectedVersion=${expectedVersion}`,
      { method: 'DELETE', clinicId },
    ),
  )
}

/* ===========================================================================
   Criacao e mensagens
   ======================================================================== */

export interface ResultadoCriacao {
  ok: boolean
  /** Falso quando o telefone ja tinha thread. NAO e erro: abrimos a existente. */
  criada?: boolean
  conversationId?: string
  mensagem?: string
}

export async function criarConversaAction(entrada: {
  contactName: string
  contactPhone: string
  patientId: string | null
}): Promise<ResultadoCriacao> {
  const clinicId = await clinica()

  const nome = entrada.contactName.trim()
  const telefoneBruto = entrada.contactPhone.trim()

  /*
   * Normalizamos aqui SO para dar erro antes da ida a rede, usando a MESMA
   * funcao que a API usa. A autoridade continua sendo o servidor: se um dia as
   * duas divergirem, quem vale e a resposta da API, e nao esta checagem.
   */
  if (telefoneBruto !== '' && toE164BR(telefoneBruto) === null) {
    return { ok: false, mensagem: 'Telefone inválido. Informe um número brasileiro válido.' }
  }
  if (nome === '' && telefoneBruto === '') {
    return { ok: false, mensagem: 'Informe ao menos o nome ou o telefone do contato.' }
  }

  try {
    const r = await apiFetch<RegisterConversationResult>('/api/conversations', {
      method: 'POST',
      body: {
        contactName: nome === '' ? null : nome,
        contactPhone: telefoneBruto === '' ? null : telefoneBruto,
        patientId: entrada.patientId,
      },
      clinicId,
    })
    revalidatePath('/atendimento')
    return { ok: true, criada: r.created, conversationId: r.conversation.id }
  } catch (error) {
    return {
      ok: false,
      mensagem: error instanceof Error ? error.message : 'Falha ao criar atendimento.',
    }
  }
}

export interface ResultadoMensagem {
  ok: boolean
  mensagem?: string
  message?: Message
  conversation?: Conversation
}

/**
 * REGISTRA uma mensagem que aconteceu fora do sistema. Nao envia nada.
 *
 * Devolve a conversa junto porque uma mensagem recebida pode REABRIR um
 * atendimento encerrado — sem isso a tela continuaria dizendo "Encerrado" logo
 * depois de algo que o reabriu.
 */
export async function registrarMensagemAction(
  id: string,
  direction: 'inbound' | 'outbound',
  body: string,
  occurredAt?: string,
): Promise<ResultadoMensagem> {
  const clinicId = await clinica()
  const texto = body.trim()
  if (texto === '') return { ok: false, mensagem: 'Escreva a mensagem antes de registrar.' }

  try {
    const r = await apiFetch<RegisterManualMessageResult>(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: { direction, body: texto, ...(occurredAt ? { occurredAt } : {}) },
      clinicId,
    })
    revalidatePath('/atendimento')
    return { ok: true, message: r.message, conversation: r.conversation }
  } catch (error) {
    return {
      ok: false,
      mensagem: error instanceof Error ? error.message : 'Falha ao registrar a mensagem.',
    }
  }
}

/* ===========================================================================
   Paginacao e apoio

   O cliente nao fala com a API direto — o token vive no servidor. Estas acoes
   existem para as listas crescerem sem recarregar a pagina inteira.
   ======================================================================== */

export async function carregarMaisConversasAction(
  cursor: string,
  filtros: { status?: string; assignment?: string; q?: string },
): Promise<Page<ConversationListItem>> {
  const clinicId = await clinica()
  const params = new URLSearchParams({ limit: '25', cursor })
  if (filtros.status) params.set('status', filtros.status)
  if (filtros.assignment && filtros.assignment !== 'all') {
    params.set('assignment', filtros.assignment)
  }
  if (filtros.q) params.set('q', filtros.q)

  return apiFetch(`/api/conversations?${params.toString()}`, { clinicId })
}

export async function carregarMaisMensagensAction(
  id: string,
  cursor: string,
): Promise<Page<Message>> {
  const clinicId = await clinica()
  return apiFetch(`/api/conversations/${id}/messages?limit=50&cursor=${encodeURIComponent(cursor)}`, {
    clinicId,
  })
}

/** Equipe da clinica, para o seletor de transferencia. Sem e-mail. */
export async function carregarEquipeAction(): Promise<ClinicMemberSummary[]> {
  const clinicId = await clinica()
  return apiFetch<ClinicMemberSummary[]>('/api/clinics/members', { clinicId })
}

/** Pacientes da clinica, para o seletor de vinculo. Reusa a API existente. */
export async function carregarPacientesAction(): Promise<
  { id: string; name: string; phone: string }[]
> {
  const clinicId = await clinica()
  return apiFetch<{ id: string; name: string; phone: string }[]>('/api/patients', { clinicId })
}
