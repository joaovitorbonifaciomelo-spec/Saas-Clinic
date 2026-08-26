import { z } from 'zod'

export const SERVICE_NAME_MIN = 2
export const SERVICE_NAME_MAX = 120
export const DURATION_MIN = 1
/** 8 horas. Acima disso e quase certamente erro de digitacao, nao um servico real. */
export const DURATION_MAX = 480

export const createServiceSchema = z.object({
  name: z.string().trim().min(SERVICE_NAME_MIN).max(SERVICE_NAME_MAX),
  durationMinutes: z
    .number()
    .int()
    .min(DURATION_MIN, 'A duracao deve ser positiva.')
    .max(DURATION_MAX, `A duracao deve ser no maximo ${DURATION_MAX} minutos.`),
  priceCents: z.number().int().min(0).nullable().optional(),
  active: z.boolean().optional(),
})

export const updateServiceSchema = createServiceSchema.partial()

export type CreateServiceInput = z.infer<typeof createServiceSchema>
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>

export interface Service {
  id: string
  clinicId: string
  name: string
  durationMinutes: number
  priceCents: number | null
  active: boolean
  createdAt: string
  updatedAt: string
}
