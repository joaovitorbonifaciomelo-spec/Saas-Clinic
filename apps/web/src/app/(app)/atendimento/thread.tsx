'use client'

import { useMemo, useState, useTransition } from 'react'
import type {
  ClinicMemberSummary,
  ConversationDetail,
  ConversationEventView,
  Message,
  Page,
} from '@clinicas/shared'
import {
  assumirAction,
  carregarMaisMensagensAction,
  devolverAction,
  mudarStatusAction,
  registrarMensagemAction,
  transferirAction,
  type ResultadoControle,
} from './atendimento-actions'
import { formatPhone } from '../../ui/format'
import { IconChevronLeft, IconCheck, IconPhone, IconUsers } from '../../ui/icons'
import { hora, rotuloDoDia } from './at-format'
import { PAPEL_UI, STATUS_UI } from './visoes'


/** Frases prontas para os eventos. O que a UI mostra e a acao, nao o payload. */
function frase(e: ConversationEventView): string {
  const quem = e.actorNameSnapshot ?? 'Alguém'
  switch (e.eventType) {
    case 'conversation_created':
      return e.metadata.patient_id
        ? `${quem} abriu o atendimento já vinculado a um paciente.`
        : `${quem} abriu o atendimento.`
    case 'assigned':
      return `${quem} assumiu o atendimento.`
    case 'transferred':
      return `${quem} transferiu o atendimento.`
    case 'released':
      return `${quem} devolveu o atendimento à fila.`
    case 'patient_linked':
      return `${quem} vinculou um paciente.`
    case 'patient_unlinked':
      return `${quem} desvinculou o paciente.`
    case 'status_changed': {
      const para = STATUS_UI[String(e.metadata.to)] ?? String(e.metadata.to)
      // Reabertura automatica: quem registrou a mensagem nao decidiu reabrir.
      if (e.metadata.reason === 'inbound_message') {
        return `Atendimento reaberto: o paciente voltou a falar.`
      }
      return `${quem} alterou o status para ${para.toLowerCase()}.`
    }
    default:
      return `${quem} atualizou o atendimento.`
  }
}

type Entrada =
  | { tipo: 'mensagem'; em: string; m: Message }
  | { tipo: 'evento'; em: string; e: ConversationEventView }
  | { tipo: 'dia'; em: string; rotulo: string }

export function Thread({
  conversa,
  mensagens,
  eventos,
  equipe,
  timezone,
  onAviso,
  onVoltar,
  onAbrirContexto,
}: {
  conversa: ConversationDetail | null
  mensagens: Page<Message>
  eventos: Page<ConversationEventView>
  equipe: ClinicMemberSummary[]
  timezone: string
  onAviso: (texto: string) => void
  onVoltar: () => void
  onAbrirContexto: () => void
}) {
  const [pendente, startTransition] = useTransition()
  const [extras, setExtras] = useState<Message[]>([])
  const [cursor, setCursor] = useState(mensagens.nextCursor)
  const [transferindo, setTransferindo] = useState(false)
  const [texto, setTexto] = useState('')
  const [direcao, setDirecao] = useState<'inbound' | 'outbound'>('outbound')
  const [registrando, setRegistrando] = useState(false)
  const [erroComposer, setErroComposer] = useState<string | null>(null)

  /** Mensagens e eventos numa linha do tempo so, com separador de dia. */
  const linha = useMemo<Entrada[]>(() => {
    const tudo: Entrada[] = [
      ...[...mensagens.items, ...extras].map((m) => ({
        tipo: 'mensagem' as const,
        em: m.occurredAt,
        m,
      })),
      ...eventos.items.map((e) => ({ tipo: 'evento' as const, em: e.createdAt, e })),
    ].sort((a, b) => a.em.localeCompare(b.em))

    const saida: Entrada[] = []
    let diaAtual = ''
    for (const item of tudo) {
      const rotulo = rotuloDoDia(item.em, timezone)
      if (rotulo !== diaAtual) {
        diaAtual = rotulo
        saida.push({ tipo: 'dia', em: item.em, rotulo })
      }
      saida.push(item)
    }
    return saida
  }, [mensagens.items, extras, eventos.items, timezone])

  if (!conversa) {
    return (
      <section className="card at-thread at-thread-vazia">
        <p className="empty">Selecione um atendimento à esquerda para ver a conversa.</p>
      </section>
    )
  }

  const c = conversa
  const nome = c.patient?.name ?? c.contactNameSnapshot ?? 'Contato sem nome'
  const responsavel = c.assignedToIsMe ? 'Você' : (c.assignedToName ?? 'Outro atendente')

  function aplicar(resultado: ResultadoControle): void {
    if (resultado.ok) return
    if (resultado.motivo === 'conflito') {
      /*
       * 409 nao e erro tecnico. A tela ja foi revalidada pelo servidor com o
       * estado devolvido pela API — aqui so contamos o que houve, em linguagem
       * humana e sem numero de versao.
       */
      onAviso('Outra pessoa alterou este atendimento enquanto você estava nele. Atualizamos as informações.')
      return
    }
    onAviso(resultado.mensagem)
  }

  const executar = (acao: () => Promise<ResultadoControle>) => () => {
    startTransition(async () => {
      aplicar(await acao())
    })
  }

  async function carregarAnteriores(): Promise<void> {
    if (!cursor) return
    const pagina = await carregarMaisMensagensAction(c.id, cursor)
    setExtras((atual) => [...atual, ...pagina.items])
    setCursor(pagina.nextCursor)
  }

  async function registrar(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (registrando) return // trava o duplo clique; NAO e idempotencia
    const corpo = texto.trim()
    if (corpo === '') return

    setRegistrando(true)
    setErroComposer(null)
    const r = await registrarMensagemAction(c.id, direcao, corpo)
    setRegistrando(false)

    if (r.ok) {
      setTexto('')
      // O servidor revalidou; a mensagem entra pela proxima renderizacao.
    } else {
      // Texto preservado de proposito: quem escreveu nao pode perder o que
      // digitou porque a rede falhou.
      setErroComposer(r.mensagem ?? 'Não foi possível registrar.')
    }
  }

  return (
    <section className="card at-thread">
      <header className="at-thread-head">
        <button type="button" className="btn ghost sm at-voltar" onClick={onVoltar}>
          <IconChevronLeft /> Fila
        </button>

        <div className="at-thread-quem">
          <h2 className="at-thread-nome">{nome}</h2>
          <div className="at-thread-meta">
            {c.contactPhoneE164 ? (
              <span className="tabular">
                <IconPhone /> {formatPhone(c.contactPhoneE164.replace(/^\+55/, ''))}
              </span>
            ) : null}
            <span className={`badge plain at-st-${c.status}`}>{STATUS_UI[c.status]}</span>
            <span className="faint">
              {c.assignedTo ? `Responsável: ${responsavel}` : 'Sem responsável'}
            </span>
          </div>
        </div>

        <div className="at-acoes">
          {/* A acao principal tem peso; as demais ficam secundarias. */}
          {!c.assignedTo ? (
            <button
              type="button"
              className="btn sm"
              disabled={pendente}
              onClick={executar(() => assumirAction(c.id, c.version))}
            >
              Assumir
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn secondary sm"
                disabled={pendente}
                onClick={() => setTransferindo((v) => !v)}
                aria-expanded={transferindo}
              >
                Transferir
              </button>
              <button
                type="button"
                className="btn secondary sm"
                disabled={pendente}
                onClick={executar(() => devolverAction(c.id, c.version))}
              >
                Devolver à fila
              </button>
            </>
          )}

          {c.status !== 'resolved' ? (
            <>
              {c.status !== 'waiting_patient' ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  disabled={pendente}
                  onClick={executar(() => mudarStatusAction(c.id, c.version, 'waiting_patient'))}
                >
                  Aguardando paciente
                </button>
              ) : null}
              <button
                type="button"
                className="btn ghost sm"
                disabled={pendente}
                onClick={executar(() => mudarStatusAction(c.id, c.version, 'resolved'))}
              >
                <IconCheck /> Encerrar
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn secondary sm"
              disabled={pendente}
              onClick={executar(() => mudarStatusAction(c.id, c.version, 'open'))}
            >
              Reabrir
            </button>
          )}

          <button type="button" className="btn ghost sm at-ver-contexto" onClick={onAbrirContexto}>
            <IconUsers /> Paciente
          </button>
        </div>

        {transferindo ? (
          <div className="at-transferir">
            <p className="label">Transferir para</p>
            <ul className="at-equipe">
              {equipe.filter((m) => m.userId !== c.assignedTo).length === 0 ? (
                <li className="faint">Não há outra pessoa na equipe desta clínica.</li>
              ) : (
                equipe
                  .filter((m) => m.userId !== c.assignedTo)
                  .map((m) => (
                    <li key={m.userId}>
                      <button
                        type="button"
                        className="at-equipe-item"
                        disabled={pendente}
                        onClick={() => {
                          setTransferindo(false)
                          startTransition(async () => {
                            aplicar(await transferirAction(c.id, c.version, m.userId))
                          })
                        }}
                      >
                        <span>{m.displayName ?? 'Sem nome cadastrado'}</span>
                        <span className="badge plain">{PAPEL_UI[m.role] ?? m.role}</span>
                      </button>
                    </li>
                  ))
              )}
            </ul>
          </div>
        ) : null}
      </header>

      {/*
        FAIXA DE MODO MANUAL — visivel, nunca em tooltip.

        Nao ha WhatsApp conectado. Se a tela deixasse isso ambiguo, a equipe
        acreditaria ter respondido alguem que nunca foi respondido.
      */}
      <div className="at-modo-manual" role="note">
        <strong>Modo manual</strong>
        <span>Mensagens registradas aqui não são enviadas nem recebidas pelo WhatsApp.</span>
      </div>

      <div className="at-linha">
        {cursor ? (
          <div className="at-mais-msgs">
            <button type="button" className="btn ghost sm" onClick={carregarAnteriores}>
              Carregar mais mensagens
            </button>
          </div>
        ) : null}

        {linha.length === 0 ? (
          <p className="empty">Nenhuma mensagem registrada neste atendimento ainda.</p>
        ) : (
          linha.map((item, i) => {
            if (item.tipo === 'dia') {
              return (
                <div key={`d-${item.rotulo}-${i}`} className="at-dia">
                  <span>{item.rotulo}</span>
                </div>
              )
            }
            if (item.tipo === 'evento') {
              // Evento nao vira bolha de mensagem: e uma nota do sistema.
              return (
                <p key={item.e.id} className="at-evento">
                  {frase(item.e)}
                  <span className="at-evento-hora tabular">{hora(item.em, timezone)}</span>
                </p>
              )
            }

            const m = item.m
            const daEquipe = m.direction === 'outbound'
            return (
              <article
                key={m.id}
                className={`at-msg ${daEquipe ? 'is-equipe' : 'is-contato'}`}
                data-direcao={m.direction}
              >
                <div className="at-msg-corpo">{m.body}</div>
                <div className="at-msg-pe">
                  {daEquipe && m.authorNameSnapshot ? (
                    <span className="at-msg-autor">{m.authorNameSnapshot}</span>
                  ) : null}
                  {/*
                    "registrado por" so aparece quando NAO e redundante: em
                    mensagem recebida, quem digitou nao e quem falou.
                  */}
                  {!daEquipe && m.recordedByNameSnapshot ? (
                    <span className="at-msg-registro" title="Quem registrou esta mensagem">
                      registrado por {m.recordedByNameSnapshot}
                    </span>
                  ) : null}
                  <span className="tabular">{hora(m.occurredAt, timezone)}</span>
                </div>
              </article>
            )
          })
        )}
      </div>

      <form className="at-composer" onSubmit={registrar}>
        <div className="at-composer-topo">
          <div className="seg at-direcao" role="group" aria-label="Quem falou">
            <button
              type="button"
              className={direcao === 'inbound' ? 'on' : ''}
              aria-pressed={direcao === 'inbound'}
              onClick={() => setDirecao('inbound')}
            >
              Paciente falou
            </button>
            <button
              type="button"
              className={direcao === 'outbound' ? 'on' : ''}
              aria-pressed={direcao === 'outbound'}
              onClick={() => setDirecao('outbound')}
            >
              Equipe respondeu
            </button>
          </div>
        </div>

        <textarea
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={3}
          maxLength={4096}
          placeholder="Registre a mensagem que ocorreu fora do sistema…"
          aria-label="Mensagem a registrar"
        />

        {erroComposer ? <p className="error at-composer-erro">{erroComposer}</p> : null}

        <div className="at-composer-pe">
          <span className="faint">Nada é enviado ao paciente por aqui.</span>
          {/* "Registrar", nunca "Enviar": o verbo descreve o que de fato ocorre. */}
          <button type="submit" className="btn sm" disabled={registrando || texto.trim() === ''}>
            {registrando ? 'Registrando…' : 'Registrar mensagem'}
          </button>
        </div>
      </form>
    </section>
  )
}
