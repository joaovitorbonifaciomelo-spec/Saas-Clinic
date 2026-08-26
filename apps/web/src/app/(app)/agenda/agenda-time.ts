import { WEEKDAY_LABELS } from '@clinicas/shared'

/**
 * Utilitarios de recorte de agenda no FUSO DA CLINICA.
 *
 * O banco guarda instantes absolutos. Quem decide onde termina a segunda-feira
 * e o fuso da clinica, nunca o do navegador — senao a mesma agenda mostraria
 * dias diferentes conforme de onde a pessoa acessa.
 */

/** Partes de um instante num fuso IANA, sem depender do fuso do processo. */
function partsIn(instant: Date, timezone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const result: Record<string, string> = {}
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') result[part.type] = part.value
  }
  if (result.hour === '24') result.hour = '00'
  return result
}

/** AAAA-MM-DD do instante, no fuso da clinica. */
export function localDateKey(instant: Date, timezone: string): string {
  const parts = partsIn(instant, timezone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** HH:MM do instante, no fuso da clinica. */
export function localTimeLabel(iso: string, timezone: string): string {
  const parts = partsIn(new Date(iso), timezone)
  return `${parts.hour}:${parts.minute}`
}

/**
 * Offset do fuso naquele instante, em minutos.
 *
 * Calculado comparando a mesma data lida em UTC e no fuso alvo. Necessario para
 * converter "AAAA-MM-DD HH:MM local" em instante absoluto sem hardcodar -03:00,
 * que estaria errado em horario de verao ou em outros fusos.
 */
function offsetMinutes(instant: Date, timezone: string): number {
  const parts = partsIn(instant, timezone)
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return (asUtc - instant.getTime()) / 60_000
}

/** Instante absoluto de uma data e hora locais da clinica. */
export function instantFromLocal(dateKey: string, time: string, timezone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const naive = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0)

  // Duas passadas: a primeira estimativa pode cair do lado errado de uma
  // transicao de horario de verao, e a segunda corrige.
  let instant = new Date(naive)
  for (let i = 0; i < 2; i += 1) {
    instant = new Date(naive - offsetMinutes(instant, timezone) * 60_000)
  }
  return instant
}

/** Comeco do dia local (00:00) como instante absoluto. */
export function startOfLocalDay(dateKey: string, timezone: string): Date {
  return instantFromLocal(dateKey, '00:00', timezone)
}

export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Dia da semana (0-6) de uma chave AAAA-MM-DD. */
export function weekdayOf(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay()
}

/** Domingo da semana que contem a data. */
export function startOfWeek(dateKey: string): string {
  return addDays(dateKey, -weekdayOf(dateKey))
}

export function formatDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-')
  return `${day}/${month}/${year}`
}

export function weekdayLabel(dateKey: string): string {
  return WEEKDAY_LABELS[weekdayOf(dateKey)] ?? ''
}

/**
 * Intervalo semiaberto [from, to) que a API deve consultar.
 * Semiaberto para que um agendamento as 00:00 pertenca a um dia so.
 */
export function rangeFor(
  dateKey: string,
  view: 'day' | 'week',
  timezone: string,
): { from: string; to: string; days: string[] } {
  const first = view === 'week' ? startOfWeek(dateKey) : dateKey
  const dayCount = view === 'week' ? 7 : 1
  const days = Array.from({ length: dayCount }, (_, index) => addDays(first, index))
  const last = addDays(first, dayCount)

  return {
    from: startOfLocalDay(first, timezone).toISOString(),
    to: startOfLocalDay(last, timezone).toISOString(),
    days,
  }
}
