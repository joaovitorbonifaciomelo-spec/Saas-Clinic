'use client'

import { useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  APPOINTMENT_STATUS_LABELS,
  WEEKDAY_LABELS,
  type AppointmentWithRelations,
  type AvailabilityBlock,
  type Patient,
  type Professional,
  type Service,
} from '@clinicas/shared'
import { addDays, formatDateLabel, localDateKey, localTimeLabel, weekdayOf } from './agenda-time'
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
}

/** Um agendamento cancelado nao ocupa horario — nao conta como conflito. */
function isActive(appointment: AppointmentWithRelations): boolean {
  return appointment.status !== 'cancelled'
}

export function AgendaView(props: AgendaViewProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [drawer, setDrawer] = useState<
    | { mode: 'create'; date: string }
    | { mode: 'edit'; appointment: AppointmentWithRelations }
    | null
  >(null)

  /** Navega mudando a URL: o estado da agenda fica compartilhavel e recarregavel. */
  function navigate(patch: Record<string, string>): void {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(patch)) {
      if (value === '') next.delete(key)
      else next.set(key, value)
    }
    router.push(`/agenda?${next.toString()}`)
  }

  const byDay = useMemo(() => {
    const map = new Map<string, AppointmentWithRelations[]>()
    for (const day of props.days) map.set(day, [])
    for (const appointment of props.appointments) {
      const key = localDateKey(new Date(appointment.startsAt), props.timezone)
      map.get(key)?.push(appointment)
    }
    return map
  }, [props.appointments, props.days, props.timezone])

  /**
   * Ids que se sobrepoem a outro agendamento do mesmo profissional.
   *
   * DERIVADO a cada render a partir dos agendamentos atuais — nunca uma flag
   * guardada. Consequencia: mover um agendamento para um horario livre faz a
   * marca de encaixe sumir sozinha, e cancelar um dos conflitantes libera o
   * outro. Cancelados nao ocupam horario, entao saem da conta.
   */
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

  /** Blocos por profissional e dia da semana, para o calculo de "fora do horario". */
  const availabilityIndex = useMemo(() => {
    const map = new Map<string, AvailabilityBlock[]>()
    for (const block of props.availability) {
      if (!block.active) continue
      const key = `${block.professionalId}:${block.weekday}`
      const list = map.get(key) ?? []
      list.push(block)
      map.set(key, list)
    }
    return map
  }, [props.availability])

  /**
   * Ids fora da disponibilidade declarada do profissional.
   *
   * Tambem derivado: se a grade do profissional mudar, ou o agendamento for
   * movido para dentro da faixa, a marca some sem intervencao. Cancelado nao
   * recebe marca — nao ha o que atender fora de hora.
   */
  const outsideAvailability = useMemo(() => {
    const flagged = new Set<string>()
    for (const appointment of props.appointments) {
      if (!isActive(appointment)) continue
      const dayKey = localDateKey(new Date(appointment.startsAt), props.timezone)
      const blocks = availabilityIndex.get(`${appointment.professionalId}:${weekdayOf(dayKey)}`)
      // Sem bloco nenhum no dia = o profissional nao atende nesse dia.
      if (!blocks || blocks.length === 0) {
        flagged.add(appointment.id)
        continue
      }
      const start = localTimeLabel(appointment.startsAt, props.timezone)
      const end = localTimeLabel(appointment.endsAt, props.timezone)
      // Cabe se algum bloco contem o intervalo inteiro; atravessar o almoco conta como fora.
      const fits = blocks.some(
        (b) => start >= b.startTime.slice(0, 5) && end <= b.endTime.slice(0, 5),
      )
      if (!fits) flagged.add(appointment.id)
    }
    return flagged
  }, [props.appointments, availabilityIndex, props.timezone])

  /** Faixas do profissional filtrado, exibidas como contexto no topo do dia. */
  const availabilityByWeekday = useMemo(() => {
    const map = new Map<number, AvailabilityBlock[]>()
    if (!props.professionalId) return map
    for (const block of props.availability) {
      if (!block.active || block.professionalId !== props.professionalId) continue
      const list = map.get(block.weekday) ?? []
      list.push(block)
      map.set(block.weekday, list)
    }
    return map
  }, [props.availability, props.professionalId])

  const step = props.view === 'week' ? 7 : 1

  return (
    <>
      <div className="card toolbar">
        <div className="toolbar-group">
          <button
            type="button"
            className={props.view === 'day' ? '' : 'secondary'}
            onClick={() => navigate({ view: 'day' })}
          >
            Dia
          </button>
          <button
            type="button"
            className={props.view === 'week' ? '' : 'secondary'}
            onClick={() => navigate({ view: 'week' })}
          >
            Semana
          </button>
        </div>

        <div className="toolbar-group">
          <button
            type="button"
            className="secondary"
            onClick={() => navigate({ date: addDays(props.date, -step) })}
            aria-label="Periodo anterior"
          >
            ←
          </button>
          <input
            type="date"
            value={props.date}
            onChange={(event) => navigate({ date: event.target.value })}
            aria-label="Data"
          />
          <button
            type="button"
            className="secondary"
            onClick={() => navigate({ date: addDays(props.date, step) })}
            aria-label="Proximo periodo"
          >
            →
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => navigate({ date: localDateKey(new Date(), props.timezone) })}
          >
            Hoje
          </button>
        </div>

        <div className="toolbar-group">
          <select
            value={props.professionalId}
            onChange={(event) => navigate({ professional: event.target.value })}
            aria-label="Filtrar por profissional"
          >
            <option value="">Todos os profissionais</option>
            {props.professionals.map((professional) => (
              <option key={professional.id} value={professional.id}>
                {professional.name}
                {professional.active ? '' : ' (inativo)'}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setDrawer({ mode: 'create', date: props.date })}>
            Novo agendamento
          </button>
        </div>
      </div>

      <div className={props.view === 'week' ? 'week-grid' : ''}>
        {props.days.map((day) => {
          const dayAppointments = byDay.get(day) ?? []
          const blocks = availabilityByWeekday.get(weekdayOf(day)) ?? []

          return (
            <section key={day} className="card day-column">
              <header className="day-header">
                <strong>{WEEKDAY_LABELS[weekdayOf(day)]}</strong>
                <span className="muted">{formatDateLabel(day)}</span>
              </header>

              {props.professionalId ? (
                <p className="availability-hint">
                  {blocks.length === 0
                    ? 'Sem disponibilidade neste dia'
                    : `Atende ${blocks
                        .map((b) => `${b.startTime.slice(0, 5)}–${b.endTime.slice(0, 5)}`)
                        .join(', ')}`}
                </p>
              ) : null}

              {dayAppointments.length === 0 ? (
                <p className="muted">Nenhum agendamento.</p>
              ) : (
                <ul className="appointment-list">
                  {dayAppointments.map((appointment) => (
                    <li key={appointment.id}>
                      <button
                        type="button"
                        className={`appointment status-${appointment.status}${
                          overlapping.has(appointment.id) ? ' has-overlap' : ''
                        }${outsideAvailability.has(appointment.id) ? ' is-outside' : ''}`}
                        onClick={() => setDrawer({ mode: 'edit', appointment })}
                      >
                        <span className="appointment-time">
                          {localTimeLabel(appointment.startsAt, props.timezone)}–
                          {localTimeLabel(appointment.endsAt, props.timezone)}
                        </span>
                        <span className="appointment-name">{appointment.patientName}</span>
                        <span className="appointment-meta">
                          {appointment.professionalName}
                          {appointment.serviceName ? ` · ${appointment.serviceName}` : ''}
                        </span>
                        <span className="appointment-status">
                          {APPOINTMENT_STATUS_LABELS[appointment.status]}
                        </span>
                        {/*
                          Marcas por texto, nao so por cor: quem tem dificuldade
                          de distinguir cor precisa ler o mesmo aviso.
                        */}
                        {overlapping.has(appointment.id) ||
                        outsideAvailability.has(appointment.id) ? (
                          <span className="appointment-flags">
                            {overlapping.has(appointment.id) ? (
                              <span className="flag flag-overlap">encaixe</span>
                            ) : null}
                            {outsideAvailability.has(appointment.id) ? (
                              <span className="flag flag-outside">fora do horário</span>
                            ) : null}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <button
                type="button"
                className="secondary block"
                onClick={() => setDrawer({ mode: 'create', date: day })}
              >
                + Agendar neste dia
              </button>
            </section>
          )
        })}
      </div>

      {drawer ? (
        <AppointmentDrawer
          timezone={props.timezone}
          patients={props.patients}
          professionals={props.professionals.filter((p) => p.active)}
          services={props.services}
          defaultDate={drawer.mode === 'create' ? drawer.date : undefined}
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
