import { describe, expect, it } from 'vitest'
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_TRANSITIONS,
  TERMINAL_APPOINTMENT_STATUSES,
  canTransition,
  changeStatusSchema,
  createAppointmentSchema,
  isTerminalStatus,
  updateAppointmentSchema,
  type AppointmentStatus,
} from './appointment'

const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const UUID_B = '3f2504e0-4f89-41d3-9a0c-0305e82c3302'

describe('maquina de estados do agendamento', () => {
  it('scheduled alcanca todos os outros estados', () => {
    // O paciente pode comparecer sem ter confirmado, e a confirmacao por
    // telefone acontece na hora — nao ha cadeia obrigatoria a percorrer.
    expect([...APPOINTMENT_STATUS_TRANSITIONS.scheduled].sort()).toEqual(
      [
        'awaiting_confirmation',
        'cancelled',
        'completed',
        'confirmed',
        'no_show',
        'reschedule_requested',
      ].sort(),
    )
  })

  it('awaiting_confirmation nao volta para scheduled', () => {
    expect(canTransition('awaiting_confirmation', 'scheduled')).toBe(false)
  })

  it('confirmed nao volta para awaiting_confirmation nem para scheduled', () => {
    expect(canTransition('confirmed', 'awaiting_confirmation')).toBe(false)
    expect(canTransition('confirmed', 'scheduled')).toBe(false)
  })

  it('reschedule_requested volta para scheduled ou awaiting_confirmation, e pode cancelar', () => {
    expect(canTransition('reschedule_requested', 'scheduled')).toBe(true)
    expect(canTransition('reschedule_requested', 'awaiting_confirmation')).toBe(true)
    expect(canTransition('reschedule_requested', 'cancelled')).toBe(true)
  })

  it('reschedule_requested nao pula direto para confirmed nem completed', () => {
    // Reagendar exige nova data antes de qualquer desfecho.
    expect(canTransition('reschedule_requested', 'confirmed')).toBe(false)
    expect(canTransition('reschedule_requested', 'completed')).toBe(false)
  })

  it('comparecimento e falta sao alcancaveis de qualquer estado ativo', () => {
    for (const from of ['scheduled', 'awaiting_confirmation', 'confirmed'] as const) {
      expect(canTransition(from, 'completed'), `${from} -> completed`).toBe(true)
      expect(canTransition(from, 'no_show'), `${from} -> no_show`).toBe(true)
    }
  })

  it('cancelamento e alcancavel de qualquer estado nao-terminal', () => {
    for (const from of APPOINTMENT_STATUSES) {
      if (isTerminalStatus(from)) continue
      expect(canTransition(from, 'cancelled'), `${from} -> cancelled`).toBe(true)
    }
  })

  it('os tres terminais nao tem nenhuma saida', () => {
    for (const status of TERMINAL_APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUS_TRANSITIONS[status], status).toEqual([])
      for (const target of APPOINTMENT_STATUSES) {
        expect(canTransition(status, target), `${status} -> ${target}`).toBe(false)
      }
    }
  })

  it('terminais sao exatamente completed, no_show e cancelled', () => {
    const terminals = APPOINTMENT_STATUSES.filter(
      (status) => APPOINTMENT_STATUS_TRANSITIONS[status].length === 0,
    )
    expect([...terminals].sort()).toEqual(['cancelled', 'completed', 'no_show'])
  })

  it('nenhum estado se lista como destino de si mesmo', () => {
    // Status inalterado nao e transicao — e tratado antes de consultar o mapa,
    // tanto no trigger quanto no service.
    for (const status of APPOINTMENT_STATUSES) {
      expect(canTransition(status, status), `${status} -> ${status}`).toBe(false)
    }
  })

  it('todo destino listado e um status valido', () => {
    for (const status of APPOINTMENT_STATUSES) {
      for (const target of APPOINTMENT_STATUS_TRANSITIONS[status]) {
        expect(APPOINTMENT_STATUSES).toContain(target)
      }
    }
  })

  it('o mapa cobre todos os status do enum', () => {
    expect(Object.keys(APPOINTMENT_STATUS_TRANSITIONS).sort()).toEqual(
      [...APPOINTMENT_STATUSES].sort(),
    )
  })

  it('changeStatusSchema rejeita status inventado', () => {
    expect(changeStatusSchema.safeParse({ status: 'rescheduled' }).success).toBe(false)
    expect(changeStatusSchema.safeParse({ status: 'confirmed' }).success).toBe(true)
  })
})

describe('createAppointmentSchema', () => {
  const base = {
    patientId: UUID_A,
    professionalId: UUID_B,
    startsAt: '2026-09-01T12:00:00.000Z',
    endsAt: '2026-09-01T12:30:00.000Z',
  }

  it('aceita um agendamento minimo', () => {
    expect(createAppointmentSchema.safeParse(base).success).toBe(true)
  })

  it('rejeita fim antes do inicio', () => {
    const result = createAppointmentSchema.safeParse({
      ...base,
      endsAt: '2026-09-01T11:00:00.000Z',
    })
    expect(result.success).toBe(false)
  })

  it('rejeita fim igual ao inicio', () => {
    const result = createAppointmentSchema.safeParse({ ...base, endsAt: base.startsAt })
    expect(result.success).toBe(false)
  })

  it('exige instante com fuso', () => {
    expect(
      createAppointmentSchema.safeParse({ ...base, startsAt: '2026-09-01 12:00' }).success,
    ).toBe(false)
  })

  it('ignora clinic_id e created_by enviados no corpo', () => {
    // O tenant vem do header validado no servidor e o autor vem do JWT.
    const parsed = createAppointmentSchema.parse({
      ...base,
      clinicId: 'clinica-de-outro-tenant',
      createdBy: 'outro-usuario',
    } as Record<string, unknown>)
    expect(parsed).not.toHaveProperty('clinicId')
    expect(parsed).not.toHaveProperty('createdBy')
  })

  it('aceita fingerprint de 64 hex e rejeita boolean generico', () => {
    const fingerprint = 'a'.repeat(64)
    expect(
      createAppointmentSchema.safeParse({ ...base, acknowledgedWarnings: fingerprint }).success,
    ).toBe(true)
    expect(
      createAppointmentSchema.safeParse({ ...base, acknowledgedWarnings: 'true' }).success,
    ).toBe(false)
  })
})

describe('updateAppointmentSchema', () => {
  it('aceita alteracao parcial de um campo so', () => {
    expect(updateAppointmentSchema.safeParse({ notes: 'Trazer exames' }).success).toBe(true)
  })

  it('nao valida a ordem quando so um dos instantes vem', () => {
    // Sem o par completo nao ha o que comparar; o banco ainda garante ends > starts.
    expect(
      updateAppointmentSchema.safeParse({ startsAt: '2026-09-01T12:00:00.000Z' }).success,
    ).toBe(true)
  })

  it('valida a ordem quando os dois instantes vem', () => {
    const result = updateAppointmentSchema.safeParse({
      startsAt: '2026-09-01T12:00:00.000Z',
      endsAt: '2026-09-01T11:00:00.000Z',
    })
    expect(result.success).toBe(false)
  })
})

/** Guarda contra o mapa e o trigger SQL divergirem silenciosamente. */
describe('paridade com o trigger do banco', () => {
  it('o mapa tem exatamente as transicoes descritas na migration', () => {
    const expected: Record<AppointmentStatus, string[]> = {
      scheduled: [
        'awaiting_confirmation',
        'confirmed',
        'reschedule_requested',
        'completed',
        'no_show',
        'cancelled',
      ],
      awaiting_confirmation: [
        'confirmed',
        'reschedule_requested',
        'completed',
        'no_show',
        'cancelled',
      ],
      confirmed: ['reschedule_requested', 'completed', 'no_show', 'cancelled'],
      reschedule_requested: ['scheduled', 'awaiting_confirmation', 'cancelled'],
      cancelled: [],
      completed: [],
      no_show: [],
    }

    for (const status of APPOINTMENT_STATUSES) {
      expect([...APPOINTMENT_STATUS_TRANSITIONS[status]].sort(), status).toEqual(
        [...expected[status]].sort(),
      )
    }
  })
})
