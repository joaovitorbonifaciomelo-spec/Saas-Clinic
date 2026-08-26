import { z } from 'zod'

export const PROFESSIONAL_NAME_MIN = 2
export const PROFESSIONAL_NAME_MAX = 120
export const SPECIALTY_MAX = 120

export const createProfessionalSchema = z.object({
  name: z.string().trim().min(PROFESSIONAL_NAME_MIN).max(PROFESSIONAL_NAME_MAX),
  specialty: z
    .string()
    .trim()
    .max(SPECIALTY_MAX)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional(),
  active: z.boolean().optional(),
})

/** clinic_id nunca faz parte do payload: o tenant vem do servidor. */
export const updateProfessionalSchema = createProfessionalSchema.partial()

export type CreateProfessionalInput = z.infer<typeof createProfessionalSchema>
export type UpdateProfessionalInput = z.infer<typeof updateProfessionalSchema>

export interface Professional {
  id: string
  clinicId: string
  name: string
  specialty: string | null
  active: boolean
  createdAt: string
  updatedAt: string
}
