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

/** Primeiro dia do mes que contem a data. */
export function startOfMonth(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`
}

/**
 * Anda N meses, sempre ancorado no DIA 1.
 *
 * Ancorar no dia 1 evita a armadilha classica: 31 de janeiro + 1 mes nao tem
 * dia 31 em fevereiro, e a maioria das implementacoes cai em 2 ou 3 de marco.
 * Como a visao Mes so precisa saber DE QUE MES se trata, o dia 1 e a resposta
 * certa e nao ha caso a tratar.
 */
export function addMonths(dateKey: string, months: number): string {
  const [year, month] = dateKey.split('-').map(Number)
  const total = year! * 12 + (month! - 1) + months
  const y = Math.floor(total / 12)
  const m = (total % 12) + 1
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`
}

/**
 * Os dias que a grade mensal desenha: do domingo da primeira semana ao sabado
 * da ultima.
 *
 * Inclui dias do mes anterior e do seguinte de proposito — a grade tem semanas
 * inteiras, e esses dias aparecem em tom secundario. Buscar o intervalo da
 * grade INTEIRA, e nao so do mes, faz com que eles mostrem os agendamentos
 * reais em vez de parecerem vazios por engano.
 */
export function monthGrid(dateKey: string): string[] {
  const primeiro = startOfMonth(dateKey)
  const inicio = startOfWeek(primeiro)
  const proximoMes = addMonths(primeiro, 1)

  const dias: string[] = []
  let atual = inicio
  // Fecha a ultima semana: para quando ja passou do mes E a semana terminou.
  while (atual < proximoMes || weekdayOf(atual) !== 0) {
    dias.push(atual)
    atual = addDays(atual, 1)
    if (dias.length > 42) break // 6 semanas e o maximo possivel
  }
  return dias
}

const MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
]

/** "Agosto de 2026" */
export function monthLabel(dateKey: string): string {
  const [year, month] = dateKey.split('-').map(Number)
  return `${MESES[month! - 1]} de ${year}`
}

export function formatDateLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-')
  return `${day}/${month}/${year}`
}

export function weekdayLabel(dateKey: string): string {
  return WEEKDAY_LABELS[weekdayOf(dateKey)] ?? ''
}

export type AgendaView = 'day' | 'week' | 'month'

/**
 * Intervalo semiaberto [from, to) que a API deve consultar.
 * Semiaberto para que um agendamento as 00:00 pertenca a um dia so.
 */
export function rangeFor(
  dateKey: string,
  view: AgendaView,
  timezone: string,
): { from: string; to: string; days: string[] } {
  /*
   * O mes consulta a GRADE inteira, nao o mes civil: os dias vizinhos que
   * completam a primeira e a ultima semana aparecem na tela e precisam mostrar
   * o que realmente tem. Continua sendo UMA consulta.
   */
  const days =
    view === 'month'
      ? monthGrid(dateKey)
      : view === 'week'
        ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(dateKey), i))
        : [dateKey]

  const first = days[0]!
  const last = addDays(days[days.length - 1]!, 1)

  return {
    from: startOfLocalDay(first, timezone).toISOString(),
    to: startOfLocalDay(last, timezone).toISOString(),
    days,
  }
}
