import { z } from 'zod'

export const PATIENT_NAME_MIN = 2
export const PATIENT_NAME_MAX = 120
export const INSURANCE_MAX = 120

/**
 * Telefone e guardado apenas com digitos. Aceitamos qualquer mascara na entrada
 * (parenteses, hifen, espaco, +) e normalizamos, para que a busca futura nao
 * dependa de como a atendente digitou.
 */
export const phoneSchema = z
  .string()
  .transform((value) => value.replace(/\D/g, ''))
  .refine(
    (digits) => digits.length >= 10 && digits.length <= 13,
    'Telefone deve ter entre 10 e 13 digitos (com DDD).',
  )

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()

export const createPatientSchema = z.object({
  name: z.string().trim().min(PATIENT_NAME_MIN).max(PATIENT_NAME_MAX),
  phone: phoneSchema,
  birthDate: z.iso.date('Data de nascimento invalida (use AAAA-MM-DD).').nullable().optional(),
  insuranceProvider: optionalTrimmed(INSURANCE_MAX),
})

/**
 * `clinic_id` NAO faz parte do payload: quem determina o tenant e o JWT do usuario
 * combinado ao header X-Clinic-Id validado no servidor, nunca o corpo da requisicao.
 */
export const updatePatientSchema = createPatientSchema.partial()

export type CreatePatientInput = z.infer<typeof createPatientSchema>
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>

export interface Patient {
  id: string
  clinicId: string
  name: string
  phone: string
  birthDate: string | null
  insuranceProvider: string | null
  createdAt: string
  updatedAt: string
}
