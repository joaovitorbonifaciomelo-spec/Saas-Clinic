'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  APPOINTMENT_STATUS_LABELS,
  type AppointmentWithRelations,
  type AvailabilityBlock,
} from '@clinicas/shared'
import { localDateKey, localTimeLabel, weekdayOf } from './agenda-time'

/** Altura de uma hora na grade. Define a escala vertical inteira. */
const HOUR_PX = 60
const DEFAULT_START = 7
const DEFAULT_END = 20

/**
 * Quanto conteudo cabe dentro de um bloco, decidido pela altura em pixels — nao
 * pela duracao em minutos. Duracao so vira altura depois de passar por HOUR_PX;
 * usar minutos como proxy foi o que fazia um bloco de 30 min pedir tres linhas
 * de texto num espaco de uma, e o corte aparecia no meio da palavra.
 *
 * Os numeros sao a soma real das alturas de linha declaradas no CSS
 * (.ag-appt-time 10.5px, .ag-appt-name 12px, line-height 1.35, gap 1px).
 */
const PAD_Y = 8
const FITS_TWO_LINES = 32
const FITS_THREE_LINES = 47
const FITS_FOUR_LINES = 62

export interface Column {
  key: string
  title: string
  subtitle?: string
  /** Dia ao qual a coluna pertence (AAAA-MM-DD). Semana = 7 dias; Dia = o mesmo. */
  dayKey: string
  /** Profissional da coluna, quando a coluna representa um profissional. */
  professionalId?: string
}

/** Bloco de agendamentos que se encostam em cadeia dentro de uma coluna. */
interface Grupo {
  itens: AppointmentWithRelations[]
  ini: number
  fim: number
  faixas: number
}

interface AgendaGridProps {
  columns: Column[]
  appointments: AppointmentWithRelations[]
  availability: AvailabilityBlock[]
  timezone: string
  overlapping: Set<string>
  outside: Set<string>
  /**
   * A partir de quantas faixas paralelas o grupo vira um bloco unico.
   * `undefined` desliga o agrupamento — e o caso da visao Dia, onde ha largura.
   */
  groupFrom?: number
  onSelect: (appointment: AppointmentWithRelations) => void
  onOpenGroup: (appointments: AppointmentWithRelations[]) => void
  onCreate: (dayKey: string, time: string, professionalId?: string) => void
}

/** Minutos desde a meia-noite local da clinica. */
function localMinutes(iso: string, timezone: string): number {
  const [h, m] = localTimeLabel(iso, timezone).split(':').map(Number)
  return h! * 60 + m!
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}

/**
 * Grade de agenda com eixo vertical de horarios.
 *
 * Substitui a lista de cartoes: cada compromisso e posicionado por `top` e
 * `height` calculados do horario real, entao a duracao vira comprimento e um
 * buraco na agenda vira buraco na tela. Uma lista nao mostra nem uma coisa nem
 * outra.
 *
 * Sobreposicoes dividem a largura da coluna entre si em vez de se cobrirem —
 * encaixe e deliberado nesta clinica, e precisa ser visivel, nao escondido.
 */
export function AgendaGrid(props: AgendaGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  /*
   * A janela visivel se adapta aos dados: comeca no default, mas estica para
   * caber qualquer agendamento ou faixa de atendimento fora dele. Sem isso, um
   * encaixe as 21h simplesmente nao apareceria.
   */
  const [startHour, endHour] = useMemo(() => {
    let min = DEFAULT_START * 60
    let max = DEFAULT_END * 60
    for (const a of props.appointments) {
      min = Math.min(min, localMinutes(a.startsAt, props.timezone))
      max = Math.max(max, localMinutes(a.endsAt, props.timezone))
    }
    for (const b of props.availability) {
      min = Math.min(min, timeToMinutes(b.startTime))
      max = Math.max(max, timeToMinutes(b.endTime))
    }
    return [Math.floor(min / 60), Math.min(24, Math.ceil(max / 60))]
  }, [props.appointments, props.availability, props.timezone])

  const totalHours = Math.max(1, endHour - startHour)
  const gridHeight = totalHours * HOUR_PX
  const toTop = (minutes: number) => ((minutes - startHour * 60) / 60) * HOUR_PX

  // Ao abrir, rola para as 8h (ou o inicio da janela) em vez da meia-noite.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = Math.max(0, toTop(Math.max(startHour, 8) * 60) - HOUR_PX)
    // Reposiciona so quando a escala muda; toTop deriva dela.
  }, [startHour, endHour])

  const horas = Array.from({ length: totalHours + 1 }, (_, i) => startHour + i)

  /** Agendamentos de uma coluna, com faixas paralelas para sobreposicoes. */
  function layout(col: Column) {
    const doDia = props.appointments
      .filter((a) => localDateKey(new Date(a.startsAt), props.timezone) === col.dayKey)
      .filter((a) => !col.professionalId || a.professionalId === col.professionalId)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))

    /*
     * Alocacao gulosa em faixas, mas por AGRUPAMENTO de sobreposicoes, nao pelo
     * dia inteiro. Um unico encaixe as 09h45 nao pode estreitar a consulta das
     * 14h: se contarmos faixas por dia, tres profissionais em paralelo por dez
     * minutos deixam todos os blocos do dia com um terco da largura, e sobra
     * espaco para quatro letras do nome do paciente.
     *
     * Um agrupamento termina quando comeca um agendamento que nao encosta em
     * nenhum dos anteriores; ai a largura volta a ser inteira.
     */
    const lanes = new Map<string, { lane: number; total: number }>()
    const laneEnd: number[] = []
    const grupos: Grupo[] = []
    let grupo: AppointmentWithRelations[] = []
    let grupoIni = -1
    let grupoFim = -1

    const fecharGrupo = () => {
      const total = Math.max(1, laneEnd.length)
      for (const a of grupo) lanes.get(a.id)!.total = total
      grupos.push({ itens: grupo, ini: grupoIni, fim: grupoFim, faixas: total })
      grupo = []
      laneEnd.length = 0
      grupoIni = -1
      grupoFim = -1
    }

    for (const a of doDia) {
      const ini = localMinutes(a.startsAt, props.timezone)
      const fim = localMinutes(a.endsAt, props.timezone)
      if (grupo.length > 0 && ini >= grupoFim) fecharGrupo()

      let lane = laneEnd.findIndex((end) => end <= ini)
      if (lane === -1) {
        lane = laneEnd.length
        laneEnd.push(fim)
      } else laneEnd[lane] = fim

      lanes.set(a.id, { lane, total: 1 })
      grupo.push(a)
      if (grupoIni === -1) grupoIni = ini
      grupoFim = Math.max(grupoFim, fim)
    }
    if (grupo.length > 0) fecharGrupo()

    /*
     * Grupos densos demais para caber lado a lado viram UM bloco.
     *
     * `groupFrom` chega da visao: no dia, uma coluna inteira e do profissional e
     * ha largura para faixas paralelas; na semana, sete colunas dividem a mesma
     * largura e tres faixas sobram ~50px cada — nome vira quatro letras, o que
     * e o mesmo que nao mostrar nome nenhum.
     *
     * Nada e descartado: os agendamentos do grupo continuam inteiros dentro de
     * `itens` e a lista abre no painel lateral ao clicar.
     */
    const agrupados =
      props.groupFrom === undefined
        ? []
        : grupos.filter((g) => g.faixas >= props.groupFrom!)
    const escondidos = new Set(agrupados.flatMap((g) => g.itens.map((a) => a.id)))

    return { doDia, lanes, agrupados, escondidos }
  }

  const nowKey = now ? localDateKey(now, props.timezone) : null
  const nowMin = now ? localMinutes(now.toISOString(), props.timezone) : 0
  const nowVisible = nowMin >= startHour * 60 && nowMin <= endHour * 60

  return (
    <div className="agenda-grid card" ref={scrollRef}>
      <div className="ag-head">
        <div className="ag-gutter-head" />
        {props.columns.map((c) => (
          <div key={c.key} className="ag-col-head">
            <span className="ag-col-title">{c.title}</span>
            {c.subtitle ? <span className="ag-col-sub">{c.subtitle}</span> : null}
          </div>
        ))}
      </div>

      <div className="ag-body" style={{ height: gridHeight }}>
        <div className="ag-gutter">
          {horas.map((h) => (
            <div key={h} className="ag-hour tabular" style={{ top: toTop(h * 60) }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>

        {props.columns.map((col) => {
          const { doDia, lanes, agrupados, escondidos } = layout(col)
          const blocos = props.availability.filter(
            (b) =>
              b.active &&
              b.weekday === weekdayOf(col.dayKey) &&
              (!col.professionalId || b.professionalId === col.professionalId),
          )

          return (
            <div key={col.key} className="ag-col">
              {/*
                A faixa de hora vazia e o alvo de criacao: clicar num buraco da
                agenda e o gesto natural de quem esta com o paciente na frente.
                O minuto vem da posicao do clique, arredondado para 15 — precisao
                de pixel viraria 10:07.
              */}
              {horas.slice(0, -1).map((h) => (
                <button
                  key={h}
                  type="button"
                  className="ag-slot"
                  style={{ top: toTop(h * 60), height: HOUR_PX }}
                  aria-label={`Novo agendamento às ${String(h).padStart(2, '0')}:00`}
                  onClick={(e) => {
                    const y = e.clientY - e.currentTarget.getBoundingClientRect().top
                    const min = Math.min(45, Math.max(0, Math.round((y / HOUR_PX) * 4) * 15))
                    props.onCreate(
                      col.dayKey,
                      `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
                      col.professionalId,
                    )
                  }}
                />
              ))}

              {/* Faixas de atendimento ao fundo: contexto, nao bloqueio. */}
              {blocos.map((b) => (
                <div
                  key={b.id}
                  className="ag-avail"
                  style={{
                    top: toTop(timeToMinutes(b.startTime)),
                    height:
                      ((timeToMinutes(b.endTime) - timeToMinutes(b.startTime)) / 60) * HOUR_PX,
                  }}
                  title={`Atende ${b.startTime.slice(0, 5)}–${b.endTime.slice(0, 5)}`}
                />
              ))}

              {nowKey === col.dayKey && nowVisible ? (
                <div className="ag-now" style={{ top: toTop(nowMin) }}>
                  <span className="ag-now-pill tabular">
                    {localTimeLabel(now!.toISOString(), props.timezone)}
                  </span>
                </div>
              ) : null}

              {/*
                Sobreposicao intensa: um bloco no lugar de N microcards. O
                horario e a contagem ficam legiveis, e a lista completa abre no
                painel lateral ao clicar.
              */}
              {agrupados.map((g) => {
                const altura = Math.max(22, ((g.fim - g.ini) / 60) * HOUR_PX - 2)
                const util = altura - PAD_Y
                const primeiro = g.itens[0]!
                const ultimo = g.itens[g.itens.length - 1]!
                const restantes = g.itens.length - 1
                const inicio = localTimeLabel(primeiro.startsAt, props.timezone)
                const termino = localTimeLabel(ultimo.endsAt, props.timezone)
                return (
                  <button
                    key={`g-${col.key}-${g.ini}`}
                    type="button"
                    className="ag-cluster"
                    onClick={() => props.onOpenGroup(g.itens)}
                    style={{
                      top: toTop(g.ini) + 1,
                      height: altura,
                      left: 2,
                      right: 5,
                    }}
                    title={`${g.itens.length} agendamentos entre ${inicio} e ${termino} — clique para ver a lista`}
                  >
                    {util >= FITS_TWO_LINES ? (
                      <span className="ag-cluster-time tabular">{inicio}</span>
                    ) : null}
                    {util >= FITS_THREE_LINES ? (
                      <span className="ag-cluster-name">{primeiro.patientName}</span>
                    ) : null}
                    <span className="ag-cluster-more">
                      {util >= FITS_THREE_LINES
                        ? `+${restantes} agendamentos`
                        : `${g.itens.length} agendamentos`}
                    </span>
                  </button>
                )
              })}

              {doDia.map((a) => {
                // Ja representado por um bloco de grupo nesta coluna.
                if (escondidos.has(a.id)) return null
                const ini = localMinutes(a.startsAt, props.timezone)
                const fim = localMinutes(a.endsAt, props.timezone)
                const faixa = lanes.get(a.id) ?? { lane: 0, total: 1 }
                const encaixe = props.overlapping.has(a.id)
                const fora = props.outside.has(a.id)

                const altura = Math.max(22, ((fim - ini) / 60) * HOUR_PX - 2)
                const util = altura - PAD_Y
                const curto = util < FITS_TWO_LINES

                /*
                 * Ordem de prioridade quando o espaco e escasso: horario e nome
                 * sempre; depois excecao (encaixe / fora do horario), que e o
                 * que faz alguem parar e olhar; so entao servico; e por ultimo o
                 * status escrito, que a cor e a borda ja comunicam.
                 */
                const excecao = encaixe || fora
                const linha3 = util >= FITS_THREE_LINES
                const linha4 = util >= FITS_FOUR_LINES
                const mostraFlags = excecao && linha3
                const mostraMeta = mostraFlags ? linha4 : linha3
                const mostraFoot = excecao ? false : linha4

                const classes = [
                  'ag-appt',
                  a.status,
                  encaixe ? 'is-overlap' : '',
                  fora ? 'is-outside' : '',
                  curto ? 'is-short' : '',
                ]
                  .filter(Boolean)
                  .join(' ')

                const detalhe = [
                  a.serviceName ?? 'Sem serviço',
                  col.professionalId ? null : a.professionalName,
                ]
                  .filter(Boolean)
                  .join(' · ')

                return (
                  <button
                    key={a.id}
                    type="button"
                    className={classes}
                    onClick={() => props.onSelect(a)}
                    style={{
                      top: toTop(ini) + 1,
                      height: altura,
                      left: `calc(${(faixa.lane / faixa.total) * 100}% + 2px)`,
                      width: `calc(${(1 / faixa.total) * 100}% - 4px)`,
                    }}
                    /*
                     * O bloco corta o que nao cabe, entao o conteudo completo
                     * precisa estar em algum lugar: aqui e no painel lateral ao
                     * clicar. Nada que a grade esconde fica inacessivel.
                     */
                    title={[
                      `${localTimeLabel(a.startsAt, props.timezone)}–${localTimeLabel(a.endsAt, props.timezone)}`,
                      a.patientName,
                      detalhe,
                      APPOINTMENT_STATUS_LABELS[a.status],
                      encaixe ? 'encaixe (sobreposição confirmada)' : null,
                      fora ? 'fora do horário de atendimento' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    <span className="ag-appt-time tabular">
                      {localTimeLabel(a.startsAt, props.timezone)}
                    </span>
                    <span className="ag-appt-name">{a.patientName}</span>
                    {mostraFlags ? (
                      <span className="ag-appt-flags">
                        {encaixe ? <span className="flag">encaixe</span> : null}
                        {fora ? <span className="flag alt">fora do horário</span> : null}
                      </span>
                    ) : null}
                    {mostraMeta ? <span className="ag-appt-meta">{detalhe}</span> : null}
                    {mostraFoot ? (
                      <span className="ag-appt-foot">
                        <span className={`dot ${a.status}`} />
                        <span>{APPOINTMENT_STATUS_LABELS[a.status]}</span>
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
