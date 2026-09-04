'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { TASK_STATUS_LABELS, type TaskListItem, type TaskView } from '@clinicas/shared'
import { PENDENCIAS_VISOES_UI, filtroDaVisao } from './pendencias-visoes'
import { carregarMaisPendenciasAction, concluirAction } from './pendencias-actions'
import { IconPlus } from '../../ui/icons'
import { prazoCurto } from './pd-format'

/**
 * Fila de pendencias: abas de visao + lista compacta + acao rapida Concluir.
 *
 * NAO ha contador por aba. A API de leitura nao expoe `/tasks/counts` — so
 * `GET /tasks` paginado —, e inventar um numero buscando 7 paginas so para
 * mostrar contadores custaria 7 idas ao banco por carregamento de tela para
 * um numero que a propria API nao promete manter exato. Preferimos nao
 * mostrar contador a mostrar um que pode mentir.
 */
export function Lista({
  itens,
  proximoCursor,
  selecionadaId,
  visao,
  timezone,
  onNova,
  onAviso,
}: {
  itens: TaskListItem[]
  proximoCursor: string | null
  selecionadaId?: string
  visao: TaskView
  timezone: string
  onNova: () => void
  onAviso: (texto: string) => void
}) {
  const router = useRouter()
  const [extras, setExtras] = useState<TaskListItem[]>([])
  const [cursor, setCursor] = useState(proximoCursor)
  const [carregando, setCarregando] = useState(false)
  const [concluindoId, setConcluindoId] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const visoesRef = useRef<HTMLDivElement>(null)

  const lista = [...itens, ...extras]

  /*
   * Abas de visao no mobile: nenhuma pode aparecer cortada no meio do
   * rotulo. O CSS sozinho nao sabe onde uma palavra termina — so medindo as
   * abas de verdade da pra saber se a que esta na borda direita cabe
   * inteira ou nao. Quando NAO cabe, --pd-corte vira a largura dela: o mask
   * em .pd-visoes (globals.css) some com ela POR INTEIRO, nunca so a ponta.
   * Roda de novo a cada scroll/resize porque a aba que fica na borda muda.
   */
  useEffect(() => {
    const el = visoesRef.current
    if (!el) return

    function recalcular(): void {
      if (!el) return
      const { clientWidth, scrollLeft } = el
      let corte = 0
      for (const aba of Array.from(el.children) as HTMLElement[]) {
        const inicio = aba.offsetLeft - scrollLeft
        const fim = inicio + aba.offsetWidth
        if (inicio < clientWidth && fim > clientWidth) {
          corte = clientWidth - inicio
          break
        }
      }
      el.style.setProperty('--pd-corte', `${corte}px`)
    }

    recalcular()
    el.addEventListener('scroll', recalcular, { passive: true })
    window.addEventListener('resize', recalcular)
    return () => {
      el.removeEventListener('scroll', recalcular)
      window.removeEventListener('resize', recalcular)
    }
  }, [])

  function paramsCom(mudanca: Record<string, string | undefined>): string {
    const p = new URLSearchParams()
    if (visao !== 'today') p.set('v', visao)
    if (selecionadaId) p.set('id', selecionadaId)
    for (const [k, v] of Object.entries(mudanca)) {
      if (v === undefined || v === '') p.delete(k)
      else p.set(k, v)
    }
    return p.toString()
  }

  async function carregarMais(): Promise<void> {
    if (!cursor || carregando) return
    setCarregando(true)
    try {
      const filtro = filtroDaVisao(visao)
      const pagina = await carregarMaisPendenciasAction(cursor, filtro)
      setExtras((atual) => [...atual, ...pagina.items])
      setCursor(pagina.nextCursor)
    } finally {
      setCarregando(false)
    }
  }

  async function concluirRapido(item: TaskListItem): Promise<void> {
    if (concluindoId) return
    setConcluindoId(item.id)
    const r = await concluirAction(item.id, item.version)
    setConcluindoId(null)
    if (!r.ok) onAviso(r.motivo === 'erro' ? r.mensagem : r.mensagem)
    startTransition(() => router.refresh())
  }

  return (
    <section className="card pd-lista">
      <div className="pd-lista-topo">
        <h1 className="pd-titulo">Pendências</h1>
        <button type="button" className="btn sm" onClick={onNova}>
          <IconPlus size={14} /> Nova pendência
        </button>
      </div>

      <div className="pd-visoes" role="tablist" aria-label="Filtrar pendências" ref={visoesRef}>
        {PENDENCIAS_VISOES_UI.map(({ chave, rotulo }) => (
          <Link
            key={chave}
            href={`/pendencias?${paramsCom({ v: chave === 'today' ? undefined : chave, id: undefined })}`}
            scroll={false}
            prefetch={false}
            role="tab"
            aria-selected={visao === chave}
            className={`pd-visao ${visao === chave ? 'is-on' : ''}`}
          >
            {rotulo}
          </Link>
        ))}
      </div>

      <div className="master-meta">
        <span className="label">
          {lista.length === 1 ? '1 pendência' : `${lista.length} pendências`}
        </span>
      </div>

      <ul className="pd-itens">
        {lista.length === 0 ? (
          <li className="pd-vazio">
            <p className="pd-vazio-titulo">Nada por aqui.</p>
            <p className="pd-vazio-sub">Nenhuma pendência se encaixa nesta visão agora.</p>
          </li>
        ) : (
          lista.map((t) => {
            const contexto = t.patient
              ? t.patient.name
              : t.conversationId
                ? 'Atendimento vinculado'
                : t.appointmentId
                  ? 'Agendamento vinculado'
                  : 'Geral'

            /*
             * O <li> E a linha da grade; o Link vira `display: contents` para
             * que seus filhos ocupem as colunas do PAI diretamente. Isso evita
             * aninhar um <button> dentro de um <a> — invalido em HTML5 e ruim
             * para leitor de tela — mantendo a linha inteira clicavel para
             * abrir, com o botao Concluir como um alvo de clique proprio.
             */
            return (
              <li key={t.id} className={`pd-item ${t.id === selecionadaId ? 'is-selected' : ''}`}>
                <Link
                  href={`/pendencias?${paramsCom({ id: t.id })}`}
                  scroll={false}
                  prefetch={false}
                  className="pd-item-link"
                  aria-current={t.id === selecionadaId ? 'true' : undefined}
                >
                  <span className="pd-item-titulo">{t.title}</span>

                  <span className="pd-item-contexto faint">{contexto}</span>

                  <span
                    className={`pd-item-prazo tabular ${t.isPastDueNow && t.status === 'open' ? 'is-atrasado' : 'faint'}`}
                  >
                    {prazoCurto(t.dueAt, timezone)}
                  </span>

                  <span className="pd-item-responsavel faint">
                    {t.assignee ? (t.isMine ? 'Você' : t.assignee.displayName ?? 'Sem nome') : 'Sem responsável'}
                  </span>

                  <span className={`badge plain pd-st-${t.status}`}>{TASK_STATUS_LABELS[t.status]}</span>
                </Link>

                {t.status === 'open' ? (
                  <button
                    type="button"
                    className="btn secondary sm pd-item-concluir"
                    disabled={concluindoId === t.id}
                    onClick={() => void concluirRapido(t)}
                  >
                    {concluindoId === t.id ? '…' : 'Concluir'}
                  </button>
                ) : (
                  <span className="pd-item-concluir" aria-hidden="true" />
                )}
              </li>
            )
          })
        )}
      </ul>

      {cursor ? (
        <div className="pd-mais">
          <button type="button" className="btn secondary sm" onClick={carregarMais} disabled={carregando}>
            {carregando ? 'Carregando…' : 'Carregar mais'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
