import { z } from 'zod'

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo'

/**
 * Valida que a string e um identificador IANA reconhecido pelo runtime.
 *
 * Nao mantemos lista propria de fusos: ela envelheceria a cada mudanca de
 * legislacao. O ICU do Node ja carrega a base tzdata, entao perguntamos a ele.
 */
export function isValidIanaTimezone(value: string): boolean {
  if (value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    isValidIanaTimezone,
    'Fuso horario invalido (use um identificador IANA, ex.: America/Sao_Paulo).',
  )

/* =============================================================================
   Cortes de dia no fuso da clinica

   A agenda e as pendencias decidem "hoje" pelo relogio da CLINICA, nunca pelo
   do servidor nem pelo do navegador. Em Sao Paulo a diferenca e de tres horas:
   um corte feito em UTC classificaria errado tudo entre 21h e a meia-noite
   local — o fim do expediente, que e quando as pendencias se acumulam.
   ========================================================================== */

/**
 * Deslocamento do fuso em relacao ao UTC, em ms, NAQUELE instante.
 *
 * O instante e truncado para o segundo antes da conta, e isso NAO e detalhe:
 * `formatToParts` nao devolve milissegundos, entao `asUtc` sempre termina em
 * `.000`. Subtrair dele um instante com milissegundos faria o "deslocamento"
 * carregar junto o resto de milissegundo — e a meia-noite calculada sairia
 * como 03:00:00.423Z em vez de 03:00:00.000Z, mudando a cada chamada.
 *
 * O sintoma era pior do que o erro: a fronteira do dia virava
 * NAO-DETERMINISTICA, e a mesma pendencia caia em "Hoje" ou em "Atrasadas"
 * dependendo do milissegundo em que a pergunta foi feita.
 */
function timezoneOffsetMs(timezone: string, instant: Date): number {
  const noSegundo = new Date(Math.floor(instant.getTime() / 1000) * 1000)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(noSegundo)) {
    if (p.type !== 'literal') parts[p.type] = p.value
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    // 24 aparece em vez de 0 em algumas versoes do ICU para a meia-noite.
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - noSegundo.getTime()
}

/**
 * Instante UTC correspondente a meia-noite local do dia de `instant`.
 *
 * O deslocamento e recalculado NA meia-noite encontrada, e nao no instante de
 * partida: num pais com horario de verao os dois podem diferir, e usar o do
 * meio-dia colocaria a fronteira uma hora fora do lugar exatamente no dia da
 * virada. O Brasil nao tem mais horario de verao, mas o produto nao e so do
 * Brasil e o custo de acertar agora e uma linha.
 */
export function startOfDayInTimezone(timezone: string, instant: Date): Date {
  const deslocado = new Date(instant.getTime() + timezoneOffsetMs(timezone, instant))
  deslocado.setUTCHours(0, 0, 0, 0)
  const tentativa = new Date(deslocado.getTime() - timezoneOffsetMs(timezone, instant))
  return new Date(deslocado.getTime() - timezoneOffsetMs(timezone, tentativa))
}

export interface DayBounds {
  /** Meia-noite local de hoje, como instante absoluto. */
  startOfToday: Date
  /** Meia-noite local de amanha. Limite EXCLUSIVO de "hoje". */
  startOfTomorrow: Date
}

/**
 * As duas fronteiras que separam Atrasadas, Hoje e Proximas.
 *
 * Devolver os dois limites juntos existe para que ninguem calcule um deles
 * sozinho: `startOfTomorrow` NAO e `startOfToday + 24h` em todo lugar do mundo,
 * e a soma ingenua erraria no dia da virada do horario de verao.
 */
export function dayBoundsInTimezone(timezone: string, instant: Date): DayBounds {
  const startOfToday = startOfDayInTimezone(timezone, instant)
  const meioDiaSeguinte = new Date(startOfToday.getTime() + 36 * 3_600_000)
  return { startOfToday, startOfTomorrow: startOfDayInTimezone(timezone, meioDiaSeguinte) }
}
