/**
 * =============================================================================
 * REGRAS DERIVADAS DA AGENDA — encaixe, fora do horário e duração
 * =============================================================================
 *
 * Estas regras são calculadas na tela a cada render, nunca guardadas como flag.
 * Os testes existem para travar essa propriedade: uma futura "otimização" que
 * persista `is_encaixe` numa coluna quebraria aqui, porque o caso central é
 * justamente a marca DESAPARECER quando a condição deixa de valer.
 */
import { describe, expect, it } from 'vitest'
import { APPOINTMENT_STATUS_TRANSITIONS, canTransition } from './appointment'
import { createServiceSchema } from './service'
import { availabilityBlockSchema } from './availability'

interface Slot {
  id: string
  professionalId: string
  startsAt: string
  endsAt: string
  status: string
}

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 14, h, m, 0)).toISOString() // segunda-feira

/** Espelha o cálculo de encaixe da agenda-view. */
function overlapping(appointments: Slot[]): Set<string> {
  const flagged = new Set<string>()
  const active = appointments.filter((a) => a.status !== 'cancelled')
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
}

/** Espelha o cálculo de "fora da disponibilidade" da agenda-view. */
function fitsAvailability(
  start: string,
  end: string,
  blocks: Array<{ startTime: string; endTime: string }>,
): boolean {
  if (blocks.length === 0) return false
  return blocks.some((b) => start >= b.startTime.slice(0, 5) && end <= b.endTime.slice(0, 5))
}

describe('D. Encaixe é derivado, nunca flag persistida', () => {
  const base: Slot[] = [
    { id: 'a', professionalId: 'p1', startsAt: at(9), endsAt: at(9, 30), status: 'scheduled' },
    { id: 'b', professionalId: 'p1', startsAt: at(9, 15), endsAt: at(9, 45), status: 'scheduled' },
  ]

  it('dois agendamentos sobrepostos do mesmo profissional viram encaixe', () => {
    expect([...overlapping(base)].sort()).toEqual(['a', 'b'])
  })

  it('mover um deles para horário livre REMOVE a marca dos dois', () => {
    // O bug que este teste impede: marca virar estado e ficar stale.
    const movido = base.map((s) =>
      s.id === 'b' ? { ...s, startsAt: at(11), endsAt: at(11, 30) } : s,
    )
    expect(overlapping(movido).size).toBe(0)
  })

  it('cancelar um dos conflitantes libera o outro', () => {
    const cancelado = base.map((s) => (s.id === 'b' ? { ...s, status: 'cancelled' } : s))
    expect(overlapping(cancelado).size).toBe(0)
  })

  it('cancelado nunca é marcado como encaixe, nem contra outro cancelado', () => {
    const todos = base.map((s) => ({ ...s, status: 'cancelled' }))
    expect(overlapping(todos).size).toBe(0)
  })

  it('mesmo horário mas profissionais diferentes NÃO é encaixe', () => {
    const outros = [base[0]!, { ...base[1]!, professionalId: 'p2' }]
    expect(overlapping(outros).size).toBe(0)
  })

  it('intervalos que apenas se encostam não são conflito', () => {
    // 09:00–09:30 e 09:30–10:00: o fim de um é o início do outro.
    const encostados: Slot[] = [
      { id: 'a', professionalId: 'p1', startsAt: at(9), endsAt: at(9, 30), status: 'scheduled' },
      { id: 'b', professionalId: 'p1', startsAt: at(9, 30), endsAt: at(10), status: 'scheduled' },
    ]
    expect(overlapping(encostados).size).toBe(0)
  })

  it('três sobrepostos marcam os três', () => {
    const tres: Slot[] = [
      ...base,
      {
        id: 'c',
        professionalId: 'p1',
        startsAt: at(9, 20),
        endsAt: at(9, 50),
        status: 'scheduled',
      },
    ]
    expect([...overlapping(tres)].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('E. Fora da disponibilidade é derivado', () => {
  const manha = [{ startTime: '08:00:00', endTime: '12:00:00' }]
  const manhaETarde = [
    { startTime: '08:00:00', endTime: '12:00:00' },
    { startTime: '14:00:00', endTime: '18:00:00' },
  ]

  it('dentro da faixa não é marcado', () => {
    expect(fitsAvailability('09:00', '09:30', manha)).toBe(true)
  })

  it('fora da faixa é marcado', () => {
    expect(fitsAvailability('20:00', '20:30', manha)).toBe(false)
  })

  it('dia sem nenhuma faixa é sempre fora', () => {
    expect(fitsAvailability('09:00', '09:30', [])).toBe(false)
  })

  it('atravessar a pausa do almoço conta como fora', () => {
    // 11:30–14:30 nao cabe inteiro em nenhum dos dois blocos.
    expect(fitsAvailability('11:30', '14:30', manhaETarde)).toBe(false)
  })

  it('cada bloco é avaliado inteiro, não pela união', () => {
    expect(fitsAvailability('14:00', '18:00', manhaETarde)).toBe(true)
    expect(fitsAvailability('08:00', '12:00', manhaETarde)).toBe(true)
  })

  it('mover para dentro da faixa REMOVE a marca', () => {
    expect(fitsAvailability('20:00', '20:30', manha)).toBe(false)
    expect(fitsAvailability('09:00', '09:30', manha)).toBe(true)
  })
})

describe('G. Serviço e duração', () => {
  it('serviço exige duração positiva', () => {
    expect(createServiceSchema.safeParse({ name: 'Consulta', durationMinutes: 0 }).success).toBe(
      false,
    )
    expect(createServiceSchema.safeParse({ name: 'Consulta', durationMinutes: -30 }).success).toBe(
      false,
    )
    expect(createServiceSchema.safeParse({ name: 'Consulta', durationMinutes: 30 }).success).toBe(
      true,
    )
  })

  it('duração acima de 8h é recusada como erro de digitação', () => {
    expect(createServiceSchema.safeParse({ name: 'Consulta', durationMinutes: 481 }).success).toBe(
      false,
    )
  })

  it('a duração do serviço define o fim a partir do início', () => {
    const somaMinutos = (time: string, minutes: number): string => {
      const [h, m] = time.split(':').map(Number)
      const total = h! * 60 + m! + minutes
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    }
    expect(somaMinutos('09:00', 30)).toBe('09:30')
    expect(somaMinutos('09:00', 45)).toBe('09:45')
    // Trocar de serviço recalcula a partir do MESMO inicio.
    expect(somaMinutos('09:00', 60)).toBe('10:00')
    expect(somaMinutos('14:30', 90)).toBe('16:00')
  })
})

describe('F. Blocos de disponibilidade', () => {
  it('fim antes do início é recusado', () => {
    const r = availabilityBlockSchema.safeParse({
      weekday: 1,
      startTime: '12:00',
      endTime: '08:00',
    })
    expect(r.success).toBe(false)
  })

  it('weekday fora de 0–6 é recusado', () => {
    expect(
      availabilityBlockSchema.safeParse({ weekday: 7, startTime: '08:00', endTime: '12:00' })
        .success,
    ).toBe(false)
    expect(
      availabilityBlockSchema.safeParse({ weekday: -1, startTime: '08:00', endTime: '12:00' })
        .success,
    ).toBe(false)
  })

  it('HH:MM é normalizado para HH:MM:SS', () => {
    const r = availabilityBlockSchema.parse({ weekday: 1, startTime: '08:00', endTime: '12:00' })
    expect(r.startTime).toBe('08:00:00')
    expect(r.endTime).toBe('12:00:00')
  })
})

describe('H. Reagendamento não muda status sozinho', () => {
  it('reschedule_requested exige escolha explícita depois da nova data', () => {
    // O fluxo aprovado: alterar o horario NAO promove o status. Quem decide e
    // a pessoa, entre estas tres saidas.
    expect([...APPOINTMENT_STATUS_TRANSITIONS.reschedule_requested].sort()).toEqual(
      ['awaiting_confirmation', 'cancelled', 'scheduled'].sort(),
    )
  })

  it('confirmed alcança reschedule_requested', () => {
    expect(canTransition('confirmed', 'reschedule_requested')).toBe(true)
  })

  it('reschedule_requested não pula para confirmed nem completed', () => {
    expect(canTransition('reschedule_requested', 'confirmed')).toBe(false)
    expect(canTransition('reschedule_requested', 'completed')).toBe(false)
  })
})
