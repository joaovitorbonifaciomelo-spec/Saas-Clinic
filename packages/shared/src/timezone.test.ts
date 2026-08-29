import { describe, expect, it } from 'vitest'
import { dayBoundsInTimezone, startOfDayInTimezone } from './timezone'

const SP = 'America/Sao_Paulo'

describe('cortes de dia no fuso da clinica', () => {
  it('meia-noite local nao carrega milissegundos', () => {
    // A regressao que este teste tranca: `formatToParts` nao devolve
    // milissegundos, e subtrair um instante que os tem fazia o deslocamento
    // absorve-los. A fronteira saia como 03:00:00.423Z e MUDAVA a cada
    // chamada — a mesma pendencia caia em "Hoje" ou em "Atrasadas" conforme o
    // milissegundo da pergunta.
    for (const ms of [0, 1, 423, 999]) {
      const instante = new Date(Date.UTC(2026, 7, 29, 15, 30, 12, ms))
      const inicio = startOfDayInTimezone(SP, instante)
      expect(inicio.getUTCMilliseconds()).toBe(0)
      expect(inicio.toISOString()).toBe('2026-08-29T03:00:00.000Z')
    }
  })

  it('e estavel: chamadas em milissegundos diferentes do mesmo dia coincidem', () => {
    const a = startOfDayInTimezone(SP, new Date(Date.UTC(2026, 7, 29, 12, 0, 0, 1)))
    const b = startOfDayInTimezone(SP, new Date(Date.UTC(2026, 7, 29, 12, 0, 0, 998)))
    expect(a.getTime()).toBe(b.getTime())
  })

  it('meia-noite de Sao Paulo e 03:00 UTC, e nao 00:00', () => {
    const { startOfToday, startOfTomorrow } = dayBoundsInTimezone(
      SP,
      new Date('2026-08-29T18:00:00.000Z'),
    )
    expect(startOfToday.toISOString()).toBe('2026-08-29T03:00:00.000Z')
    expect(startOfTomorrow.toISOString()).toBe('2026-08-30T03:00:00.000Z')
  })

  it('21h local ainda e HOJE, mesmo ja sendo amanha em UTC', () => {
    const agora = new Date('2026-08-29T18:00:00.000Z')
    const { startOfToday, startOfTomorrow } = dayBoundsInTimezone(SP, agora)
    const vinteEUma = new Date('2026-08-30T00:00:00.000Z') // 21h em Sao Paulo

    expect(vinteEUma >= startOfToday).toBe(true)
    expect(vinteEUma < startOfTomorrow).toBe(true)
    // Em UTC o dia ja virou: e exatamente por isso que o corte nao pode ser UTC.
    expect(vinteEUma.getUTCDate()).toBe(30)
  })

  it('a virada local acontece as 03:00 UTC, nao antes', () => {
    const { startOfToday } = dayBoundsInTimezone(SP, new Date('2026-08-29T02:59:59.000Z'))
    // 02:59 UTC ainda e dia 28 em Sao Paulo.
    expect(startOfToday.toISOString()).toBe('2026-08-28T03:00:00.000Z')
  })

  it('UTC como fuso da clinica corta a meia-noite UTC', () => {
    const { startOfToday, startOfTomorrow } = dayBoundsInTimezone(
      'UTC',
      new Date('2026-08-29T18:00:00.000Z'),
    )
    expect(startOfToday.toISOString()).toBe('2026-08-29T00:00:00.000Z')
    expect(startOfTomorrow.toISOString()).toBe('2026-08-30T00:00:00.000Z')
  })

  it('amanha e sempre exatamente um dia local depois, e nao "mais 24h"', () => {
    const { startOfToday, startOfTomorrow } = dayBoundsInTimezone(
      SP,
      new Date('2026-08-29T18:00:00.000Z'),
    )
    expect(startOfTomorrow.getTime() - startOfToday.getTime()).toBe(86_400_000)
  })
})
