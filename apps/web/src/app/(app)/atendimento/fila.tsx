'use client'

import { useEffect, useOptimistic, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  CONVERSATION_STATUS_LABELS,
  type ConversationListItem,
} from '@clinicas/shared'
import { filtroDaVisao, STATUS_UI, VISOES_UI, type VisaoFila } from './visoes'
import { carregarMaisConversasAction } from './atendimento-actions'
import { formatPhone, initials } from '../../ui/format'
import { IconPlus, IconSearch } from '../../ui/icons'
import { horaOuData } from './at-format'


export function Fila({
  itens,
  proximoCursor,
  selecionadaId,
  visao,
  busca,
  timezone,
  onAbrir,
  onNovo,
}: {
  itens: ConversationListItem[]
  proximoCursor: string | null
  selecionadaId?: string
  visao: VisaoFila
  busca: string
  timezone: string
  onAbrir: () => void
  onNovo: () => void
}) {
  const router = useRouter()
  const [q, setQ] = useState(busca)
  const [extras, setExtras] = useState<ConversationListItem[]>([])
  const [cursor, setCursor] = useState(proximoCursor)
  const [carregando, setCarregando] = useState(false)
  /*
   * No celular a fila e a tela inteira, e o campo de busca custava uma faixa de
   * altura que quase nunca era usada. Ele passa a abrir por um icone — no
   * desktop continua sempre visivel, onde nao ha essa disputa por espaco.
   *
   * Comeca aberto quando ja ha busca ativa: esconder o termo que filtra a lista
   * deixaria a pessoa sem entender por que ha tao poucos resultados.
   */
  const [buscaAberta, setBuscaAberta] = useState(busca !== '')
  const campoBusca = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (buscaAberta) campoBusca.current?.focus()
  }, [buscaAberta])

  /*
   * O realce muda na hora do clique; a conversa a direita continua a anterior
   * ate a nova chegar. Sem isso, o item so acendia depois da ida e volta
   * inteira — o mesmo clique morto ja corrigido em Pacientes e na Agenda.
   */
  const [pendente, startTransition] = useTransition()
  const [selecionada, setSelecionada] = useOptimistic(selecionadaId)

  const lista = [...itens, ...extras]

  function abrir(id: string): void {
    onAbrir()
    startTransition(() => {
      setSelecionada(id)
      router.push(`/atendimento?${paramsCom({ c: id })}`, { scroll: false })
    })
  }

  function paramsCom(mudanca: Record<string, string | undefined>): string {
    const p = new URLSearchParams()
    if (selecionadaId) p.set('c', selecionadaId)
    if (visao !== 'todas') p.set('v', visao)
    if (busca) p.set('q', busca)
    for (const [k, v] of Object.entries(mudanca)) {
      if (v === undefined || v === '') p.delete(k)
      else p.set(k, v)
    }
    return p.toString()
  }

  function buscar(e: React.FormEvent): void {
    e.preventDefault()
    // A busca vai para o SERVIDOR: a fila e paginada, entao filtrar o que ja
    // esta em memoria acharia so dentro da primeira pagina.
    startTransition(() => {
      setExtras([])
      router.push(`/atendimento?${paramsCom({ q: q.trim() || undefined, c: undefined })}`, {
        scroll: false,
      })
    })
  }

  async function carregarMais(): Promise<void> {
    if (!cursor || carregando) return
    setCarregando(true)
    try {
      const filtro = filtroDaVisao(visao)
      const pagina = await carregarMaisConversasAction(cursor, {
        status: filtro.status,
        assignment: filtro.assignment,
        q: busca || undefined,
      })
      setExtras((atual) => [...atual, ...pagina.items])
      setCursor(pagina.nextCursor)
    } finally {
      setCarregando(false)
    }
  }

  return (
    <aside className="card master at-fila">
      <div className="master-head at-fila-head" data-busca={buscaAberta ? 'aberta' : 'fechada'}>
        <div className="at-fila-topo">
          <h1 className="at-titulo">Atendimento</h1>
          {/* So aparece no celular; no desktop a busca ja esta na tela. */}
          <button
            type="button"
            className="btn ghost sm at-busca-toggle"
            aria-expanded={buscaAberta}
            aria-label={buscaAberta ? 'Fechar busca' : 'Buscar atendimentos'}
            onClick={() => {
              if (buscaAberta && q !== '') {
                // Fechar com termo digitado limparia o filtro sem avisar.
                setQ('')
                startTransition(() => {
                  router.push(`/atendimento?${paramsCom({ q: undefined, c: undefined })}`, {
                    scroll: false,
                  })
                })
              }
              setBuscaAberta((v) => !v)
            }}
          >
            <IconSearch />
          </button>
        </div>
        <form className="search inline at-busca" onSubmit={buscar} role="search">
          <IconSearch />
          <input
            ref={campoBusca}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome ou telefone"
            aria-label="Buscar atendimentos"
          />
        </form>
      </div>

      <div className="at-visoes" role="tablist" aria-label="Filtrar atendimentos">
        {VISOES_UI.map(({ chave, rotulo }) => (
          <Link
            key={chave}
            href={`/atendimento?${paramsCom({ v: chave === 'todas' ? undefined : chave, c: undefined })}`}
            scroll={false}
            prefetch={false}
            role="tab"
            aria-selected={visao === chave}
            className={`at-visao ${visao === chave ? 'is-on' : ''}`}
          >
            {rotulo}
          </Link>
        ))}
      </div>

      <div className="master-meta">
        <span className="label">
          {lista.length === 1 ? '1 atendimento' : `${lista.length} atendimentos`}
        </span>
        <button type="button" className="btn sm" onClick={onNovo}>
          <IconPlus size={14} /> Novo atendimento
        </button>
      </div>

      <ul className="master-list at-lista" data-pendente={pendente ? 'sim' : undefined}>
        {lista.length === 0 ? (
          <li className="at-vazio">
            <p className="at-vazio-titulo">Nenhum atendimento por aqui.</p>
            <p className="at-vazio-sub">
              No modo manual, você registra aqui as conversas que aconteceram por telefone ou no
              balcão.
            </p>
            <button type="button" className="btn sm" onClick={onNovo}>
              <IconPlus size={14} /> Novo atendimento manual
            </button>
          </li>
        ) : (
          lista.map((c) => {
            const nome = c.patientName ?? c.contactNameSnapshot ?? 'Contato sem nome'
            return (
              <li key={c.id}>
                <Link
                  href={`/atendimento?${paramsCom({ c: c.id })}`}
                  scroll={false}
                  prefetch={false}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                      return
                    }
                    event.preventDefault()
                    abrir(c.id)
                  }}
                  className={`master-item at-item ${c.id === selecionada ? 'is-selected' : ''}`}
                  aria-current={c.id === selecionada ? 'true' : undefined}
                >
                  <span className="avatar sm">{initials(nome)}</span>

                  <span className="at-item-corpo">
                    <span className="at-item-topo">
                      <span className="master-name">{nome}</span>
                      <span className="faint tabular at-item-hora">
                        {horaOuData(c.lastMessageAt, timezone)}
                      </span>
                    </span>

                    <span className="at-item-preview">
                      {c.lastMessagePreview ? (
                        <>
                          {c.lastMessageDirection === 'outbound' ? (
                            <span className="at-seta" aria-hidden="true">
                              ↩
                            </span>
                          ) : null}
                          {c.lastMessagePreview}
                        </>
                      ) : (
                        <span className="faint">Sem mensagens registradas</span>
                      )}
                    </span>

                    <span className="at-item-rodape">
                      <span className={`badge plain at-st-${c.status}`}>
                        {STATUS_UI[c.status] ?? CONVERSATION_STATUS_LABELS[c.status]}
                      </span>
                      {c.assignedTo ? (
                        <span className="faint at-resp">
                          {c.assignedToIsMe ? 'Você' : (c.assignedToName ?? 'Outro atendente')}
                        </span>
                      ) : (
                        <span className="faint at-resp">Sem responsável</span>
                      )}
                      {c.contactPhoneE164 ? (
                        <span className="faint tabular at-tel">
                          {formatPhone(c.contactPhoneE164.replace(/^\+55/, ''))}
                        </span>
                      ) : null}
                    </span>
                  </span>

                  {/* Derivado de lastInbound > lastOutbound. Nao ha contador de
                      nao lidas: seria um numero que sobe e desce por caminhos
                      diferentes e diverge do estado real. */}
                  {c.needsReply ? (
                    <span className="at-atencao" title="O paciente falou por último">
                      <span className="dot awaiting" />
                    </span>
                  ) : null}
                </Link>
              </li>
            )
          })
        )}
      </ul>

      {cursor ? (
        <div className="at-mais">
          <button
            type="button"
            className="btn secondary sm"
            onClick={carregarMais}
            disabled={carregando}
          >
            {carregando ? 'Carregando…' : 'Carregar mais'}
          </button>
        </div>
      ) : null}
    </aside>
  )
}
