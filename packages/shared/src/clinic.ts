import { z } from 'zod'
import { type clinicRoleSchema } from './roles'

/** Limites iguais aos do CHECK em `public.clinics.name` e aos da RPC create_clinic_with_owner. */
export const CLINIC_NAME_MIN = 2
export const CLINIC_NAME_MAX = 120

export const createClinicSchema = z.object({
  name: z
    .string()
    .trim()
    .min(CLINIC_NAME_MIN, `Nome da clinica deve ter ao menos ${CLINIC_NAME_MIN} caracteres.`)
    .max(CLINIC_NAME_MAX, `Nome da clinica deve ter no maximo ${CLINIC_NAME_MAX} caracteres.`),
})

export type CreateClinicInput = z.infer<typeof createClinicSchema>

export interface Clinic {
  id: string
  name: string
  /** Fuso IANA da clinica. Define o recorte de dia e semana da agenda. */
  timezone: string
  createdAt: string
}

/** Uma clinica da qual o usuario participa, junto do papel dele nela. */
export interface ClinicMembership {
  clinicId: string
  clinicName: string
  clinicTimezone: string
  role: z.infer<typeof clinicRoleSchema>
}
