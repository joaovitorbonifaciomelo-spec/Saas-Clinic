import { z } from 'zod'

/** 0 = domingo … 6 = sabado, igual ao `dow` do Postgres e ao getDay() do JS. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const
export const WEEKDAY_LABELS = [
  'Domingo',
  'Segunda',
  'Terca',
  'Quarta',
  'Quinta',
  'Sexta',
  'Sabado',
] as const

/** HH:MM ou HH:MM:SS — o Postgres devolve com segundos, o <input type="time"> envia sem. */
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Horario invalido (use HH:MM).')
  .transform((value) => (value.length === 5 ? `${value}:00` : value))

export const availabilityBlockSchema = z
  .object({
    weekday: z
      .number()
      .int()
      .min(0, 'Dia da semana deve ser 0 a 6.')
      .max(6, 'Dia da semana deve ser 0 a 6.'),
    startTime: timeSchema,
    endTime: timeSchema,
    active: z.boolean().optional(),
  })
  .refine((block) => block.endTime > block.startTime, {
    message: 'O fim deve ser depois do inicio.',
    path: ['endTime'],
  })

/**
 * A grade inteira do profissional e enviada de uma vez e substituida numa
 * transacao. Editar bloco a bloco exigiria reconciliacao no cliente para um
 * ganho nenhum: a tela ja edita a semana como um todo.
 */
export const replaceAvailabilitySchema = z.object({
  blocks: z.array(availabilityBlockSchema).max(50),
})

export type AvailabilityBlockInput = z.infer<typeof availabilityBlockSchema>
export type ReplaceAvailabilityInput = z.infer<typeof replaceAvailabilitySchema>

export interface AvailabilityBlock {
  id: string
  clinicId: string
  professionalId: string
  weekday: number
  startTime: string
  endTime: string
  active: boolean
}
