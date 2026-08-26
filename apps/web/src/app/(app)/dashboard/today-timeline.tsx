'use client'

import { useEffect, useState } from 'react'
import { APPOINTMENT_STATUS_LABELS, type AppointmentWithRelations } from '@clinicas/shared'
import { localDateKey, localTimeLabel } from '../agenda/agenda-time'
import { initials, minutesBetween } from '../../ui/format'

/**
 * Lista cronologica do dia com marcador de "agora".
 *
 * Cliente por um motivo so: a linha do horario atual precisa ser calculada no
 * relogio do navegador e atualizada sozinha. Renderizar no servidor daria um
 * horario congelado no instante do build da resposta.
 */
export function TodayTimeline({
  appointments,
  timezone,
}: {
  appointments: AppointmentWithRelations[]
  timezone: string
}) {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const ordenados = [...appointments].sort((a, b) => a.startsAt.localeCompare(b.startsAt))

  if (ordenados.length === 0) {
    return <p className="empty">Nenhum agendamento para hoje.</p>
  }

  const ehHoje = now
    ? localDateKey(now, timezone) === localDateKey(new Date(ordenados[0]!.startsAt), timezone)
    : false
  const agoraMs = now?.getTime() ?? 0
  const indiceAgora = ehHoje ? ordenados.findIndex((a) => Date.parse(a.startsAt) > agoraMs) : -1

  return (
    <ul className="timeline">
      {ordenados.map((a, i) => (
        <li key={a.id}>
          {i === indiceAgora ? (
            <div className="now-line" aria-label="Horário atual">
              <span className="now-pill tabular">
                {localTimeLabel(now!.toISOString(), timezone)}
              </span>
            </div>
          ) : null}
          <div className={`tl-row ${a.status === 'cancelled' ? 'is-cancelled' : ''}`}>
            <div className="tl-time tabular">
              <strong>{localTimeLabel(a.startsAt, timezone)}</strong>
              <span className="faint">{minutesBetween(a.startsAt, a.endsAt)} min</span>
            </div>
            <span className={`tl-dot ${a.status}`} />
            <span className="avatar sm">{initials(a.patientName)}</span>
            <div className="tl-main">
              <div className="tl-name">{a.patientName}</div>
              <div className="faint">{a.serviceName ?? 'Sem serviço'}</div>
            </div>
            <div className="tl-prof faint">{a.professionalName}</div>
            <span className={`badge ${a.status}`}>{APPOINTMENT_STATUS_LABELS[a.status]}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}
