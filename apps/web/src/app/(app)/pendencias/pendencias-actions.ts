'use server'

import { revalidatePath } from 'next/cache'
import {
  TASK_INVALID_STATE_ERROR,
  TASK_INVALID_REASON_LABELS,
  TASK_PATIENT_MISMATCH_ERROR,
  type ClinicMemberSummary,
  type CreateTaskInput,
  type Page,
  type Task,
  type TaskDetail,
  type TaskEventView,
  type TaskInvalidReason,
  type TaskListItem,
} from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'

/**
 * Resultado de toda acao de controle.
 *
 * Tres motivos de recusa, e nao um "erro" generico — espelhando de proposito o
 * `ResultadoControle` de `atendimento-actions.ts`, so que com o terceiro braco
 * que o Atendimento nao tem: `estado_invalido`. A API distingue tres 409
 * diferentes porque cada um pede uma REACAO diferente da tela; achatar os tres
 * aqui devolveria a mesma confusao para quem programa o componente.
 */
export type ResultadoControle =
  | { ok: true; task: Task }
  | { ok: false; motivo: 'conflito'; mensagem: string; task: Task }
  | { ok: false; motivo: 'estado_invalido'; mensagem: string; reason: TaskInvalidReason; task: Task }
  | { ok: false; motivo: 'paciente_incompativel'; mensagem: string }
  | { ok: false; motivo: 'erro'; mensagem: string }

interface CorpoErro {
  error?: string
  message?: string
  reason?: TaskInvalidReason
  current?: Task
}

/**
 * Traduz a resposta da API para algo que a tela sabe desenhar.
 *
 * `estado_invalido` usa `TASK_INVALID_REASON_LABELS` — a mensagem ja vem
 * pronta, em portugues, com a correcao ("Use transferir", "Reabra a
 * pendência..."). Nao reescrevemos essa copy aqui: ela e a MESMA que o backend
 * decidiu que a tela deveria mostrar, e reescreve-la criaria uma segunda fonte
 * de verdade capaz de divergir da primeira.
 */
async function executar(chamada: () => Promise<Task>): Promise<ResultadoControle> {
  try {
    const task = await chamada()
    revalidatePath('/pendencias')
    return { ok: true, task }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error

    const corpo = error.payload as CorpoErro | null

    if (error.status === 409 && corpo?.current) {
      revalidatePath('/pendencias')

      if (corpo.error === TASK_INVALID_STATE_ERROR && corpo.reason) {
        return {
          ok: false,
          motivo: 'estado_invalido',
          mensagem: TASK_INVALID_REASON_LABELS[corpo.reason],
          reason: corpo.reason,
          task: corpo.current,
        }
      }
      return {
        ok: false,
        motivo: 'conflito',
        mensagem: corpo.message ?? 'Esta pendência foi alterada por outra pessoa.',
        task: corpo.current,
      }
    }

    if (error.status === 409 && corpo?.error === TASK_PATIENT_MISMATCH_ERROR) {
      return {
        ok: false,
        motivo: 'paciente_incompativel',
        mensagem: corpo.message ?? 'Esta conversa já está vinculada a outro paciente.',
      }
    }

    // 404 tambem cai aqui: a pendencia sumiu ou nunca foi desta clinica. A
    // lista se corrige no proximo carregamento.
    return { ok: false, motivo: 'erro', mensagem: error.message }
  }
}

async function clinica(): Promise<string> {
  const { activeClinic } = await requireActiveSession()
  return activeClinic.clinicId
}

/* ===========================================================================
   Criacao
   ======================================================================== */

export interface ResultadoCriacao {
  ok: boolean
  id?: string
  mensagem?: string
}

export async function criarPendenciaAction(entrada: CreateTaskInput): Promise<ResultadoCriacao> {
  const clinicId = await clinica()
  try {
    const criada = await apiFetch<TaskDetail>('/api/tasks', {
      method: 'POST',
      body: entrada,
      clinicId,
    })
    revalidatePath('/pendencias')
    return { ok: true, id: criada.id }
  } catch (error) {
    if (error instanceof ApiError) {
      const corpo = error.payload as CorpoErro | null
      if (error.status === 409 && corpo?.error === TASK_PATIENT_MISMATCH_ERROR) {
        return {
          ok: false,
          mensagem: corpo.message ?? 'Esta conversa já está vinculada a outro paciente.',
        }
      }
      if (error.status === 404) {
        return { ok: false, mensagem: 'Paciente, conversa, agendamento ou responsável não encontrado.' }
      }
      return { ok: false, mensagem: error.message }
    }
    throw error
  }
}

/* ===========================================================================
   Controle
   ======================================================================== */

export async function editarDetalhesAction(
  id: string,
  expectedVersion: number,
  title: string,
  description: string | null,
) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/details`, {
      method: 'PATCH',
      // Os DOIS campos vao sempre juntos: o formulario de edicao mostra titulo
      // e descricao atuais e submete os dois. Enviar so o que mudou exigiria
      // rastrear qual campo foi tocado, e um erro nesse rastreio apagaria o
      // outro campo em silencio — `description` ausente do corpo significa
      // "nao mexer", e omitir por engano teria esse efeito.
      body: { expectedVersion, title, description },
      clinicId,
    }),
  )
}

/** Assumir para si. `assigneeId` sai da sessao, nunca de input do cliente. */
export async function assumirAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  const { profile } = await requireActiveSession()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/assign`, {
      method: 'POST',
      body: { expectedVersion, assigneeId: profile.id },
      clinicId,
    }),
  )
}

/** Atribuir a um colega especifico — pendencia ainda sem responsavel. */
export async function atribuirAction(id: string, expectedVersion: number, assigneeId: string) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/assign`, {
      method: 'POST',
      body: { expectedVersion, assigneeId },
      clinicId,
    }),
  )
}

export async function transferirAction(id: string, expectedVersion: number, assigneeId: string) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/transfer`, {
      method: 'POST',
      body: { expectedVersion, assigneeId },
      clinicId,
    }),
  )
}

export async function devolverAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/release`, {
      method: 'POST',
      body: { expectedVersion },
      clinicId,
    }),
  )
}

/** `dueAt: null` remove o prazo — "Sem prazo" e visao real, nao ausencia de dado. */
export async function definirPrazoAction(id: string, expectedVersion: number, dueAt: string | null) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/due`, {
      method: 'PATCH',
      body: { expectedVersion, dueAt },
      clinicId,
    }),
  )
}

export async function concluirAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/complete`, {
      method: 'POST',
      body: { expectedVersion },
      clinicId,
    }),
  )
}

export async function cancelarAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/cancel`, {
      method: 'POST',
      body: { expectedVersion },
      clinicId,
    }),
  )
}

export async function reabrirAction(id: string, expectedVersion: number) {
  const clinicId = await clinica()
  return executar(() =>
    apiFetch<Task>(`/api/tasks/${id}/reopen`, {
      method: 'POST',
      body: { expectedVersion },
      clinicId,
    }),
  )
}

/* ===========================================================================
   Paginacao e apoio
   ======================================================================== */

export async function carregarMaisPendenciasAction(
  cursor: string,
  filtros: { status: string; due: string; assignment: string },
): Promise<Page<TaskListItem>> {
  const clinicId = await clinica()
  const params = new URLSearchParams({
    limit: '50',
    cursor,
    status: filtros.status,
    due: filtros.due,
    assignment: filtros.assignment,
  })
  return apiFetch(`/api/tasks?${params.toString()}`, { clinicId })
}

export async function carregarMaisEventosAction(
  id: string,
  cursor: string,
): Promise<Page<TaskEventView>> {
  const clinicId = await clinica()
  return apiFetch(`/api/tasks/${id}/events?limit=30&cursor=${encodeURIComponent(cursor)}`, {
    clinicId,
  })
}

/** Equipe da clinica, para os seletores de atribuir/transferir. Sem e-mail. */
export async function carregarEquipeAction(): Promise<ClinicMemberSummary[]> {
  const clinicId = await clinica()
  return apiFetch<ClinicMemberSummary[]>('/api/clinics/members', { clinicId })
}

/** Pacientes da clinica, para o seletor de contexto na criacao. */
export async function carregarPacientesAction(): Promise<
  { id: string; name: string; phone: string }[]
> {
  const clinicId = await clinica()
  return apiFetch<{ id: string; name: string; phone: string }[]>('/api/patients', { clinicId })
}
