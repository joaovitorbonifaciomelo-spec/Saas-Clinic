'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  WEEKDAY_LABELS,
  type AppointmentWithRelations,
  type AvailabilityBlock,
  type Patient,
  type Professional,
  type Service,
} from '@clinicas/shared'
import { addDays, formatDateLabel, localDateKey, localTimeLabel, weekdayOf } from './agenda-time'
import { fullDateLabel, shortDateLabel } from '../../ui/format'
import { IconChevronLeft, IconChevronRight, IconPlus } from '../../ui/icons'
import { AgendaGrid, type Column } from './agenda-grid'
import { AppointmentDrawer } from './appointment-drawer'

interface AgendaViewProps {
  view: 'day' | 'week'
  date: string
  days: string[]
  timezone: string
  professionalId: string
  appointments: AppointmentWithRelations[]
  professionals: Professional[]
  services: Service[]
  patients: Patient[]
  availability: AvailabilityBlock[]
  openNew: boolean
  presetPatientId?: string
}

/** Cancelado nao ocupa horario — nao conta como conflito. */
function isActive(a: AppointmentWithRelations): boolean {
  return a.status !== 'cancelled'
}

export function AgendaView(props: AgendaViewProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [drawer, setDrawer] = useState<
    | { mode: 'create'; date: string; time?: string; professionalId?: string }
    | { mode: 'edit'; appointment: AppointmentWithRelations }
    | null
  >(props.openNew ? { mode: 'create', date: props.date } : null)

  function navigate(patch: Record<string, string>): void {
    const next = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(patch)) {
      if (v === '') next.delete(k)
      else next.set(k, v)
    }
    next.delete('novo')
    router.push(`/agenda?${next.toString()}`)
  }

  /** Encaixe: derivado a cada render, nunca flag guardada. */
  const overlapping = useMemo(() => {
    const flagged = new Set<string>()
    const active = props.appointments.filter(isActive)
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i]!
        const b = active[j]!
        if (a.professionalId !== b.professionalId) continue
        if (a.startsAt < b.endsAt && b.startsAt < a.endsAt) {
          flagged.add(a.id)
          flagged.add(b.id)
        }
      }
    }
    return flagged
  }, [props.appointments])

  const availabilityIndex = useMemo(() => {
    const map = new Map<string, AvailabilityBlock[]>()
    for (const b of props.availability) {
      if (!b.active) continue
      const key = `${b.professionalId}:${b.weekday}`
      const list = map.get(key) ?? []
      list.push(b)
      map.set(key, list)
    }
    return map
  }, [props.availability])

  /** Fora da disponibilidade: tambem derivado. */
  const outside = useMemo(() => {
    const flagged = new Set<string>()
    for (const a of props.appointments) {
      if (!isActive(a)) continue
      const dayKey = localDateKey(new Date(a.startsAt), props.timezone)
      const blocks = availabilityIndex.get(`${a.professionalId}:${weekdayOf(dayKey)}`)
      if (!blocks || blocks.length === 0) {
        flagged.add(a.id)
        continue
      }
      const s = localTimeLabel(a.startsAt, props.timezone)
      const e = localTimeLabel(a.endsAt, props.timezone)
      if (!blocks.some((b) => s >= b.startTime.slice(0, 5) && e <= b.endTime.slice(0, 5))) {
        flagged.add(a.id)
      }
    }
    return flagged
  }, [props.appointments, availabilityIndex, props.timezone])

  const ativos = props.professionals.filter((p) => p.active)
  const selecionado = props.professionals.find((p) => p.id === props.professionalId)

  /*
   * Colunas.
   *
   * Dia sem filtro -> uma coluna por profissional, como a agenda de uma
   * recepcao de verdade. Com filtro -> uma coluna so.
   * Semana -> sempre sete colunas de dia; misturar profissional e dia na mesma
   * grade daria 7 x N colunas e nada seria legivel.
   */
  const columns: Column[] = useMemo(() => {
    if (props.view === 'week') {
      return props.days.map((d) => ({
        key: d,
        title: (WEEKDAY_LABELS[weekdayOf(d)] ?? '').slice(0, 3).toUpperCase(),
        subtitle: formatDateLabel(d).slice(0, 5),
        dayKey: d,
        professionalId: props.professionalId || undefined,
      }))
    }
    if (props.professionalId) {
      return [
        {
          key: props.professionalId,
          title: selecionado?.name ?? 'Profissional',
          subtitle: selecionado?.specialty ?? undefined,
          dayKey: props.date,
          professionalId: props.professionalId,
        },
      ]
    }
    if (ativos.length === 0) {
      return [{ key: 'todos', title: 'Agenda', dayKey: props.date }]
    }
    return ativos.map((p) => ({
      key: p.id,
      title: p.name,
      subtitle: p.specialty ?? undefined,
      dayKey: props.date,
      professionalId: p.id,
    }))
  }, [props.view, props.days, props.professionalId, props.date, ativos, selecionado])

  const step = props.view === 'week' ? 7 : 1
  const primeiro = props.days[0]!
  const ultimo = props.days[props.days.length - 1]!
  const periodo =
    props.view === 'week'
      ? `${shortDateLabel(primeiro)} – ${shortDateLabel(ultimo)} de ${ultimo.slice(0, 4)}`
      : fullDateLabel(props.date)

  const doPeriodo = props.appointments.filter(isActive)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agenda</h1>
          <p className="page-sub">
            {doPeriodo.length} {doPeriodo.length === 1 ? 'agendamento' : 'agendamentos'} no período
          </p>
        </div>
        <button type="button" onClick={() => setDrawer({ mode: 'create', date: props.date })}>
          <IconPlus /> Novo agendamento
        </button>
      </div>

      <div className="card agenda-toolbar">
        <div className="tb-group">
          <button
            type="button"
            className="secondary sm"
            onClick={() => navigate({ date: localDateKey(new Date(), props.timezone) })}
          >
            Hoje
          </button>
          <button
            type="button"
            className="ghost sm"
            aria-label="Período anterior"
            onClick={() => navigate({ date: addDays(props.date, -step) })}
          >
            <IconChevronLeft />
          </button>
          <button
            type="button"
            className="ghost sm"
            aria-label="Próximo período"
            onClick={() => navigate({ date: addDays(props.date, step) })}
          >
            <IconChevronRight />
          </button>
          <span className="tb-period">{periodo}</span>
        </div>

        <div className="tb-group tb-right">
          <input
            type="date"
            className="tb-date"
            value={props.date}
            onChange={(e) => navigate({ date: e.target.value })}
            aria-label="Ir para data"
          />
          <select
            className="tb-select"
            value={props.professionalId}
            onChange={(e) => navigate({ professional: e.target.value })}
            aria-label="Filtrar por profissional"
          >
            <option value="">Todos os profissionais</option>
            {props.professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.active ? '' : ' (inativo)'}
              </option>
            ))}
          </select>
          <div className="seg">
            <button
              type="button"
              aria-pressed={props.view === 'day'}
              onClick={() => navigate({ view: 'day' })}
            >
              Dia
            </button>
            <button
              type="button"
              aria-pressed={props.view === 'week'}
              onClick={() => navigate({ view: 'week' })}
            >
              Semana
            </button>
          </div>
        </div>
      </div>

      <AgendaGrid
        columns={columns}
        appointments={props.appointments}
        availability={props.availability}
        timezone={props.timezone}
        overlapping={overlapping}
        outside={outside}
        onSelect={(a) => setDrawer({ mode: 'edit', appointment: a })}
        onCreate={(dayKey, time, professionalId) =>
          setDrawer({ mode: 'create', date: dayKey, time, professionalId })
        }
      />

      <div className="agenda-legend">
        <span>
          <span className="dot confirmed" /> Confirmado
        </span>
        <span>
          <span className="dot awaiting_confirmation" /> Aguardando confirmação
        </span>
        <span>
          <span className="dot scheduled" /> Agendado
        </span>
        <span>
          <span className="dot reschedule_requested" /> Reagendamento solicitado
        </span>
        <span>
          <span className="dot completed" /> Realizado
        </span>
        <span>
          <span className="dot no_show" /> Falta
        </span>
        <span>
          <span className="dot cancelled" /> Cancelado
        </span>
        <span className="legend-sep" />
        <span>
          <span className="swatch avail" /> Faixa de atendimento
        </span>
        <span>
          <span className="flag">encaixe</span> sobreposição confirmada
        </span>
        <span>
          <span className="flag alt">fora do horário</span> override confirmado
        </span>
      </div>

      {drawer ? (
        <AppointmentDrawer
          timezone={props.timezone}
          patients={props.patients}
          professionals={ativos}
          services={props.services}
          defaultDate={drawer.mode === 'create' ? drawer.date : undefined}
          defaultTime={drawer.mode === 'create' ? drawer.time : undefined}
          defaultProfessionalId={drawer.mode === 'create' ? drawer.professionalId : undefined}
          defaultPatientId={drawer.mode === 'create' ? props.presetPatientId : undefined}
          appointment={drawer.mode === 'edit' ? drawer.appointment : undefined}
          onClose={() => setDrawer(null)}
          onSaved={() => {
            setDrawer(null)
            router.refresh()
          }}
        />
      ) : null}
    </>
  )
}
