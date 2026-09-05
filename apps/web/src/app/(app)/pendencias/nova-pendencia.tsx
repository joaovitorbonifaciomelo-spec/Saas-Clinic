'use client'

import { useEffect, useState } from 'react'
import type { ClinicMemberSummary } from '@clinicas/shared'
import { TASK_TITLE_MAX, TASK_DESCRIPTION_MAX } from '@clinicas/shared'
import { carregarPacientesAction, criarPendenciaAction } from './pendencias-actions'
import { formatPhone } from '../../ui/format'
import { deDatetimeLocal } from './pd-format'

/**
 * Nova pendencia.
 *
 * Contexto e OPCIONAL — uma pendencia geral da clinica e legitima, e nao ha
 * campo algum "obrigando" a escolher paciente, conversa ou agendamento. So
 * paciente aparece como SELETOR aqui: nao existe seletor reutilizavel de
 * conversa nem de agendamento no projeto (ver `atendimento/painel-contexto.tsx`,
 * que tambem so busca paciente), e inventar um agora seria escopo que esta
 * rodada nao pediu.
 *
 * `contexto` e o outro caminho de entrada: quando Atendimento, Paciente ou
 * Agendamento abrem este MESMO formulario a partir da propria tela (em vez de
 * abri-lo a partir de /pendencias), o id relevante (conversationId,
 * appointmentId, patientId — cada tela manda o que tem) ja vem decidido —
 * a pessoa so preenche titulo, descricao, prazo e responsavel. Por isso o
 * seletor de paciente NEM aparece neste modo: mostrar um campo cuja resposta
 * ja esta fixada, so pra ficar desabilitado, seria pior do que omiti-lo.
 *
 * `conversationId` e `appointmentId` sao mutuamente exclusivos na pratica
 * (cada tela manda o seu, nunca os dois), mas nada aqui impede os dois juntos
 * porque o proprio `createTaskSchema` ja aceita essa combinacao — nao ha
 * necessidade de reforcar uma regra que a tela nunca vai violar.
 */
type Contexto = {
  conversationId?: string
  appointmentId?: string
  patientId: string | null
  patientName: string | null
}

/** Frase fixa mostrada no lugar do seletor de paciente, por origem. */
function fraseContexto(ctx: Contexto): string {
  if (ctx.conversationId) {
    return ctx.patientName
      ? `Vinculada ao atendimento e a ${ctx.patientName}.`
      : 'Vinculada a este atendimento — a conversa ainda não tem paciente.'
  }
  if (ctx.appointmentId) {
    return ctx.patientName
      ? `Vinculada a este agendamento e a ${ctx.patientName}.`
      : 'Vinculada a este agendamento — sem paciente vinculado.'
  }
  // So patientId: veio da propria ficha do paciente, que sempre tem nome.
  return `Vinculada a ${ctx.patientName}.`
}

export function NovaPendencia({
  equipe,
  timezone,
  contexto,
  onFechar,
  onCriada,
}: {
  equipe: ClinicMemberSummary[]
  timezone: string
  contexto?: Contexto
  onFechar: () => void
  onCriada: (id: string) => void
}) {
  const [titulo, setTitulo] = useState('')
  const [descricao, setDescricao] = useState('')
  const [prazo, setPrazo] = useState('')
  const [responsavelId, setResponsavelId] = useState('')
  const [pacienteId, setPacienteId] = useState('')
  const [pacientes, setPacientes] = useState<{ id: string; name: string; phone: string }[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    if (contexto) return // contexto ja decide paciente: nao ha o que listar.
    carregarPacientesAction()
      .then(setPacientes)
      .catch(() => setPacientes([]))
  }, [contexto])

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFechar()
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [onFechar])

  async function salvar(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (salvando) return

    const tituloLimpo = titulo.trim()
    if (tituloLimpo.length < 3) {
      setErro('O título precisa de pelo menos 3 caracteres.')
      return
    }

    setSalvando(true)
    setErro(null)

    const r = await criarPendenciaAction({
      title: tituloLimpo,
      description: descricao.trim() === '' ? null : descricao.trim(),
      dueAt: prazo === '' ? null : deDatetimeLocal(prazo, timezone),
      assignedTo: responsavelId === '' ? null : responsavelId,
      patientId: contexto ? contexto.patientId : pacienteId === '' ? null : pacienteId,
      conversationId: contexto?.conversationId ?? null,
      appointmentId: contexto?.appointmentId ?? null,
    })
    setSalvando(false)

    if (r.ok && r.id) {
      onCriada(r.id)
    } else {
      setErro(r.mensagem ?? 'Não foi possível criar a pendência.')
    }
  }

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onFechar()
      }}
    >
      <div className="drawer pd-drawer" role="dialog" aria-modal="true" aria-label="Nova pendência">
        <div className="drawer-head">
          <h2>Nova pendência</h2>
          <button type="button" className="btn ghost sm" onClick={onFechar}>
            Fechar
          </button>
        </div>

        <form className="pd-form" onSubmit={salvar}>
          <label>
            <span className="label">Título</span>
            <input
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              maxLength={TASK_TITLE_MAX}
              placeholder="O que precisa ser feito"
              autoFocus
              required
            />
          </label>

          <label>
            <span className="label">Descrição (opcional)</span>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              maxLength={TASK_DESCRIPTION_MAX}
              rows={3}
              placeholder="Instrução operacional — o que fazer, não anotação clínica"
            />
          </label>

          <div className="field-row">
            <label>
              <span className="label">Prazo (opcional)</span>
              <input type="datetime-local" value={prazo} onChange={(e) => setPrazo(e.target.value)} />
            </label>

            <label>
              <span className="label">Responsável (opcional)</span>
              <select value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)}>
                <option value="">Fila geral</option>
                {equipe.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName ?? 'Sem nome cadastrado'}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {contexto ? (
            // Contexto vem da tela de origem, nao e escolha de quem preenche.
            <p className="faint">{fraseContexto(contexto)}</p>
          ) : (
            <label>
              <span className="label">Paciente (opcional)</span>
              <select value={pacienteId} onChange={(e) => setPacienteId(e.target.value)}>
                <option value="">Pendência geral da clínica</option>
                {pacientes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatPhone(p.phone)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {erro ? <p className="error">{erro}</p> : null}

          <div className="pd-form-pe">
            <button type="button" className="btn secondary sm" onClick={onFechar}>
              Cancelar
            </button>
            <button type="submit" className="btn sm" disabled={salvando}>
              {salvando ? 'Criando…' : 'Criar pendência'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
