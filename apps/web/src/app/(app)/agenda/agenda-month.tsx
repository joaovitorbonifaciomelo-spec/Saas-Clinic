'use client'

import { useMemo } from 'react'
import { APPOINTMENT_STATUS_LABELS, type AppointmentWithRelations } from '@clinicas/shared'
import { localDateKey, localTimeLabel } from './agenda-time'

/**
 * Visao Mes: panorama e navegacao, nao detalhe.
 *
 * A grade nao tenta reproduzir a visao Dia. Cada dia mostra poucas linhas
 * compactas — hora + nome — e o resto vira "+N mais", que leva ao Dia. Deixar a
 * celula crescer com o numero de agendamentos quebraria o proposito: o valor
 * aqui e enxergar o mes inteiro de uma vez.
 */

/** Quantas linhas cabem antes do "+N mais". Fixo por decisao, nao por medida. */
const MAX_ITENS = 3

export interface DiaDoMes {
  key: string
  doMes: boolean
  hoje: boolean
}

export function AgendaMonth({
  dias,
  mesReferencia,
  appointments,
  timezone,
  onCreate,
  onSelect,
  onOpenDay,
}: {
  dias: string[]
  /** 'YYYY-MM' do mes exibido: define quem e do mes e quem e vizinho. */
  mesReferencia: string
  appointments: AppointmentWithRelations[]
  timezone: string
  onCreate: (dayKey: string) => void
  onSelect: (a: AppointmentWithRelations) => void
  onOpenDay: (dayKey: string) => void
}) {
  const hojeKey = localDateKey(new Date(), timezone)

  /*
   * Indexa por dia UMA vez.
   *
   * Sem isto, cada uma das ate 42 celulas filtraria a lista inteira — 42
   * varreduras por render, e a cada navegacao de mes. O agrupamento usa o fuso
   * da CLINICA: um agendamento as 23h de sabado nao pode aparecer no domingo
   * porque o navegador da atendente esta em outro fuso.
   */
  const porDia = useMemo(() => {
    const mapa = new Map<string, AppointmentWithRelations[]>()
    for (const a of appointments) {
      const key = localDateKey(new Date(a.startsAt), timezone)
      const lista = mapa.get(key)
      if (lista) lista.push(a)
      else mapa.set(key, [a])
    }
    for (const lista of mapa.values()) lista.sort((x, y) => x.startsAt.localeCompare(y.startsAt))
    return mapa
  }, [appointments, timezone])

  const semanas = useMemo(() => {
    const linhas: string[][] = []
    for (let i = 0; i < dias.length; i += 7) linhas.push(dias.slice(i, i + 7))
    return linhas
  }, [dias])

  return (
    <div className="mes" role="grid" aria-label="Calendário do mês">
      <div className="mes-head" role="row">
        {['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((d) => (
          <div key={d} className="mes-head-cel" role="columnheader">
            {d}
          </div>
        ))}
      </div>

      {semanas.map((semana) => (
        <div key={semana[0]} className="mes-semana" role="row">
          {semana.map((dia) => {
            const doMes = dia.slice(0, 7) === mesReferencia
            const hoje = dia === hojeKey
            const doDia = porDia.get(dia) ?? []
            const visiveis = doDia.slice(0, MAX_ITENS)
            const restantes = doDia.length - visiveis.length

            return (
              <div
                key={dia}
                role="gridcell"
                className={`mes-cel${doMes ? '' : ' fora'}${hoje ? ' hoje' : ''}`}
                data-dia={dia}
              >
                {/*
                  O numero do dia e um alvo de navegacao, nao decoracao: leva a
                  visao Dia. No celular ele cobre a celula inteira (ver CSS) —
                  ali "criar ao tocar no vazio" seria toque acidental garantido.
                */}
                <button
                  type="button"
                  className="mes-num"
                  onClick={() => onOpenDay(dia)}
                  aria-label={`Abrir o dia ${dia}`}
                >
                  {Number(dia.slice(8, 10))}
                </button>

                {/* Contagem so no celular, onde as linhas nao cabem. */}
                {doDia.length > 0 ? (
                  <span className="mes-contagem" aria-hidden="true">
                    {doDia.length}
                  </span>
                ) : null}

                <div className="mes-itens">
                  {visiveis.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={`mes-item ${a.status}`}
                      onClick={() => onSelect(a)}
                      title={`${localTimeLabel(a.startsAt, timezone)} ${a.patientName} — ${
                        APPOINTMENT_STATUS_LABELS[a.status]
                      }`}
                    >
                      <span className={`dot ${a.status}`} aria-hidden="true" />
                      <span className="mes-hora tabular">
                        {localTimeLabel(a.startsAt, timezone)}
                      </span>
                      <span className="mes-nome">{a.patientName}</span>
                    </button>
                  ))}

                  {restantes > 0 ? (
                    // Leva ao Dia em vez de abrir uma lista aqui: o Dia ja
                    // mostra tudo com horario, profissional e conflito.
                    <button type="button" className="mes-mais" onClick={() => onOpenDay(dia)}>
                      + {restantes} {restantes === 1 ? 'mais' : 'mais'}
                    </button>
                  ) : null}
                </div>

                {/* Area livre da celula cria agendamento naquela data. */}
                <button
                  type="button"
                  className="mes-vazio"
                  onClick={() => onCreate(dia)}
                  aria-label={`Novo agendamento em ${dia}`}
                  tabIndex={-1}
                />
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
