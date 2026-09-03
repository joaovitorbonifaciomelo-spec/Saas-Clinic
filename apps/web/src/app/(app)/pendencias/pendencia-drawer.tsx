'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  TASK_DESCRIPTION_MAX,
  TASK_STATUS_LABELS,
  TASK_TITLE_MAX,
  type ClinicMemberSummary,
  type Page,
  type TaskDetail,
  type TaskEventView,
} from '@clinicas/shared'
import {
  assumirAction,
  atribuirAction,
  cancelarAction,
  concluirAction,
  definirPrazoAction,
  devolverAction,
  editarDetalhesAction,
  reabrirAction,
  transferirAction,
  type ResultadoControle,
} from './pendencias-actions'
import { formatPhone, initials } from '../../ui/format'
import { IconCheck, IconClock } from '../../ui/icons'
import { deDatetimeLocal, hora, paraDatetimeLocal, prazoLongo } from './pd-format'

/** Frases prontas para os eventos. A tela mostra a ACAO, nao o payload cru. */
function frase(e: TaskEventView): string {
  const quem = e.actorNameSnapshot ?? 'Alguém'
  switch (e.eventType) {
    case 'created':
      return `${quem} criou a pendência.`
    case 'details_changed': {
      const campos = (e.metadata.fields as string[] | undefined) ?? []
      const rotulo = campos.map((c) => (c === 'title' ? 'título' : 'descrição')).join(' e ')
      return `${quem} alterou ${rotulo || 'os detalhes'}.`
    }
    case 'assigned': {
      const alvo = e.metadata.to as { displayName?: string | null } | undefined
      return `${quem} atribuiu a ${alvo?.displayName ?? 'alguém'}.`
    }
    case 'transferred': {
      const alvo = e.metadata.to as { displayName?: string | null } | undefined
      return `${quem} transferiu para ${alvo?.displayName ?? 'alguém'}.`
    }
    case 'released':
      return `${quem} devolveu a pendência à fila.`
    case 'due_changed': {
      const para = e.metadata.to as string | null | undefined
      return para ? `${quem} alterou o prazo.` : `${quem} removeu o prazo.`
    }
    case 'completed':
      return `${quem} concluiu a pendência.`
    case 'reopened':
      return `${quem} reabriu a pendência.`
    case 'cancelled':
      return `${quem} cancelou a pendência.`
    default:
      return `${quem} atualizou a pendência.`
  }
}

export function PendenciaDrawer({
  pendencia,
  eventos,
  equipe,
  timezone,
  onFechar,
  onAviso,
}: {
  pendencia: TaskDetail
  eventos: Page<TaskEventView>
  equipe: ClinicMemberSummary[]
  timezone: string
  onFechar: () => void
  onAviso: (texto: string) => void
}) {
  const [pendente, startTransition] = useTransition()
  const [editando, setEditando] = useState(false)
  const [tituloEdit, setTituloEdit] = useState(pendencia.title)
  const [descricaoEdit, setDescricaoEdit] = useState(pendencia.description ?? '')
  const [editandoPrazo, setEditandoPrazo] = useState(false)
  const [prazoEdit, setPrazoEdit] = useState(
    pendencia.dueAt ? paraDatetimeLocal(pendencia.dueAt, timezone) : '',
  )
  const [seletor, setSeletor] = useState<'atribuir' | 'transferir' | null>(null)
  const ancoraSeletor = useRef<HTMLDivElement>(null)

  const p = pendencia
  const terminal = p.status !== 'open'
  const candidatos = equipe.filter((m) => m.userId !== p.assignedTo)

  // Reabre os campos de edicao sempre que uma pendencia DIFERENTE e aberta.
  useEffect(() => {
    setEditando(false)
    setTituloEdit(p.title)
    setDescricaoEdit(p.description ?? '')
    setEditandoPrazo(false)
    setPrazoEdit(p.dueAt ? paraDatetimeLocal(p.dueAt, timezone) : '')
  }, [p.id])

  useEffect(() => {
    if (!seletor) return
    const foraDaAncora = (alvo: EventTarget | null) =>
      alvo instanceof Node && ancoraSeletor.current && !ancoraSeletor.current.contains(alvo)
    const aoClicar = (e: MouseEvent) => {
      if (foraDaAncora(e.target)) setSeletor(null)
    }
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSeletor(null)
    }
    document.addEventListener('mousedown', aoClicar)
    document.addEventListener('keydown', aoTeclar)
    return () => {
      document.removeEventListener('mousedown', aoClicar)
      document.removeEventListener('keydown', aoTeclar)
    }
  }, [seletor])

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !seletor) onFechar()
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [seletor])

  function aplicar(r: ResultadoControle): void {
    if (r.ok) return
    if (r.motivo === 'conflito') {
      // A tela ja foi revalidada com o estado devolvido pela API. O aviso e
      // so o "porque" em linguagem humana — sem numero de versao.
      onAviso('Outra pessoa alterou esta pendência enquanto você estava nela. Atualizamos as informações.')
      return
    }
    // `estado_invalido` chega com a mensagem pronta de TASK_INVALID_REASON_LABELS
    // — ja explica a acao invalida e o que fazer, nunca "erro de rede".
    onAviso(r.mensagem)
  }

  const executar = (acao: () => Promise<ResultadoControle>) => () => {
    startTransition(async () => {
      aplicar(await acao())
    })
  }

  function salvarDetalhes(e: React.FormEvent): void {
    e.preventDefault()
    const titulo = tituloEdit.trim()
    if (titulo.length < 3) return
    startTransition(async () => {
      const r = await editarDetalhesAction(
        p.id,
        p.version,
        titulo,
        descricaoEdit.trim() === '' ? null : descricaoEdit.trim(),
      )
      if (r.ok) setEditando(false)
      aplicar(r)
    })
  }

  function salvarPrazo(e: React.FormEvent): void {
    e.preventDefault()
    startTransition(async () => {
      const r = await definirPrazoAction(
        p.id,
        p.version,
        prazoEdit === '' ? null : deDatetimeLocal(prazoEdit, timezone),
      )
      if (r.ok) setEditandoPrazo(false)
      aplicar(r)
    })
  }

  return (
    <div className="drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onFechar()}>
      <div className="drawer pd-drawer" role="dialog" aria-modal="true" aria-label="Detalhe da pendência">
        <div className="drawer-head">
          <h2>Pendência</h2>
          <button type="button" className="btn ghost sm" onClick={onFechar}>
            Fechar
          </button>
        </div>

        {terminal ? (
          <p className="pd-terminal-nota" role="note">
            Esta pendência está {p.status === 'completed' ? 'concluída' : 'cancelada'}. Reabra para
            poder alterá-la.
          </p>
        ) : null}

        <div className="pd-drawer-corpo">
          {editando ? (
            <form className="pd-form" onSubmit={salvarDetalhes}>
              <label>
                <span className="label">Título</span>
                <input
                  value={tituloEdit}
                  onChange={(e) => setTituloEdit(e.target.value)}
                  maxLength={TASK_TITLE_MAX}
                  autoFocus
                />
              </label>
              <label>
                <span className="label">Descrição</span>
                <textarea
                  value={descricaoEdit}
                  onChange={(e) => setDescricaoEdit(e.target.value)}
                  maxLength={TASK_DESCRIPTION_MAX}
                  rows={3}
                />
              </label>
              <div className="pd-form-pe">
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => {
                    setEditando(false)
                    setTituloEdit(p.title)
                    setDescricaoEdit(p.description ?? '')
                  }}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn sm" disabled={pendente}>
                  Salvar
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="pd-titulo-linha">
                <h3 className="pd-drawer-titulo">{p.title}</h3>
                <span className={`badge plain pd-st-${p.status}`}>{TASK_STATUS_LABELS[p.status]}</span>
              </div>
              {p.description ? (
                <p className="pd-descricao">{p.description}</p>
              ) : (
                <p className="faint">Sem descrição.</p>
              )}
              {!terminal ? (
                <button type="button" className="btn ghost sm" onClick={() => setEditando(true)}>
                  Editar título/descrição
                </button>
              ) : null}
            </>
          )}

          <div className="pd-bloco">
            <p className="label">Prazo</p>
            {editandoPrazo ? (
              <form className="pd-prazo-form" onSubmit={salvarPrazo}>
                <input
                  type="datetime-local"
                  value={prazoEdit}
                  onChange={(e) => setPrazoEdit(e.target.value)}
                  autoFocus
                />
                <div className="pd-form-pe">
                  <button type="button" className="btn secondary sm" onClick={() => setEditandoPrazo(false)}>
                    Cancelar
                  </button>
                  <button type="submit" className="btn sm" disabled={pendente}>
                    Salvar
                  </button>
                </div>
              </form>
            ) : (
              <div className="pd-linha-acao">
                <span className={p.isPastDueNow && p.status === 'open' ? 'pd-prazo-atrasado' : ''}>
                  <IconClock size={14} /> {prazoLongo(p.dueAt, timezone)}
                </span>
                {!terminal ? (
                  <span className="pd-linha-botoes">
                    <button type="button" className="btn ghost sm" onClick={() => setEditandoPrazo(true)}>
                      {p.dueAt ? 'Alterar' : 'Definir prazo'}
                    </button>
                    {p.dueAt ? (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={pendente}
                        onClick={executar(() => definirPrazoAction(p.id, p.version, null))}
                      >
                        Remover
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </div>
            )}
          </div>

          <div className="pd-bloco">
            <p className="label">Responsável</p>
            <div className="pd-linha-acao">
              <span>{p.assignee ? (p.isMine ? 'Você' : p.assignee.displayName ?? 'Sem nome') : 'Sem responsável — fila geral'}</span>
              {!terminal ? (
                <span className="pd-linha-botoes">
                  {!p.assignedTo ? (
                    <>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={pendente}
                        onClick={executar(() => assumirAction(p.id, p.version))}
                      >
                        Assumir
                      </button>
                      <div className="pd-pop-anchor" ref={seletor === 'atribuir' ? ancoraSeletor : null}>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={pendente}
                          aria-expanded={seletor === 'atribuir'}
                          aria-haspopup="dialog"
                          onClick={() => setSeletor((v) => (v === 'atribuir' ? null : 'atribuir'))}
                        >
                          Atribuir a…
                        </button>
                        {seletor === 'atribuir' ? (
                          <SeletorEquipe
                            candidatos={equipe}
                            onEscolher={(userId) => {
                              setSeletor(null)
                              startTransition(async () => {
                                aplicar(await atribuirAction(p.id, p.version, userId))
                              })
                            }}
                          />
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="pd-pop-anchor" ref={seletor === 'transferir' ? ancoraSeletor : null}>
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={pendente}
                          aria-expanded={seletor === 'transferir'}
                          aria-haspopup="dialog"
                          onClick={() => setSeletor((v) => (v === 'transferir' ? null : 'transferir'))}
                        >
                          Transferir
                        </button>
                        {seletor === 'transferir' ? (
                          <SeletorEquipe
                            candidatos={candidatos}
                            onEscolher={(userId) => {
                              setSeletor(null)
                              startTransition(async () => {
                                aplicar(await transferirAction(p.id, p.version, userId))
                              })
                            }}
                          />
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={pendente}
                        onClick={executar(() => devolverAction(p.id, p.version))}
                      >
                        Devolver à fila
                      </button>
                    </>
                  )}
                </span>
              ) : null}
            </div>
          </div>

          <div className="pd-bloco">
            <p className="label">Contexto</p>
            {p.patient ? (
              <div className="pd-contexto-item">
                <span className="avatar sm">{initials(p.patient.name)}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="master-name">{p.patient.name}</div>
                  <div className="faint tabular">{formatPhone(p.patient.phone)}</div>
                </div>
                <Link href={`/patients?p=${p.patient.id}`} prefetch={false} className="btn ghost sm">
                  Ver paciente
                </Link>
              </div>
            ) : null}

            {p.conversation ? (
              <div className="pd-contexto-item">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="master-name">
                    {p.conversation.contactName ?? 'Atendimento sem nome de contato'}
                  </div>
                  <div className="faint">
                    {p.conversation.contactPhoneE164 ? formatPhone(p.conversation.contactPhoneE164.replace(/^\+55/, '')) : null}
                  </div>
                </div>
                <Link href={`/atendimento?c=${p.conversation.id}`} prefetch={false} className="btn ghost sm">
                  Ver atendimento
                </Link>
              </div>
            ) : null}

            {p.appointment ? (
              <div className="pd-contexto-item">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="master-name">
                    {new Intl.DateTimeFormat('pt-BR', {
                      timeZone: timezone,
                      day: '2-digit',
                      month: 'short',
                    }).format(new Date(p.appointment.startsAt))}{' '}
                    às {hora(p.appointment.startsAt, timezone)}
                  </div>
                  <div className="faint">{p.appointment.professionalName ?? 'Profissional não informado'}</div>
                </div>
              </div>
            ) : null}

            {!p.patient && !p.conversation && !p.appointment ? (
              <p className="faint">Pendência geral da clínica — sem paciente, conversa ou agendamento vinculado.</p>
            ) : null}
          </div>

          <div className="pd-bloco">
            <p className="label">Histórico</p>
            <ul className="pd-historico">
              {eventos.items.map((e) => (
                <li key={e.id} className="pd-evento">
                  <span className="pd-evento-marca" aria-hidden="true" />
                  <span className="pd-evento-texto">{frase(e)}</span>
                  <span className="faint tabular pd-evento-hora">{hora(e.createdAt, timezone)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="pd-drawer-pe">
          {terminal ? (
            <button
              type="button"
              className="btn sm"
              disabled={pendente}
              onClick={executar(() => reabrirAction(p.id, p.version))}
            >
              Reabrir
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn ghost sm pd-cancelar"
                disabled={pendente}
                onClick={executar(() => cancelarAction(p.id, p.version))}
              >
                Cancelar pendência
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={pendente}
                onClick={executar(() => concluirAction(p.id, p.version))}
              >
                <IconCheck size={14} /> Concluir
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SeletorEquipe({
  candidatos,
  onEscolher,
}: {
  candidatos: ClinicMemberSummary[]
  onEscolher: (userId: string) => void
}) {
  return (
    <div className="pd-pop" role="dialog" aria-label="Escolher responsável">
      <ul className="pd-equipe">
        {candidatos.length === 0 ? (
          <li className="pd-pop-vazio">Não há outra pessoa na equipe desta clínica.</li>
        ) : (
          candidatos.map((m) => (
            <li key={m.userId}>
              <button type="button" className="pd-equipe-item" onClick={() => onEscolher(m.userId)}>
                {m.displayName ?? 'Sem nome cadastrado'}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
