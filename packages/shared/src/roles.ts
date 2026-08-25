import { z } from 'zod'

/**
 * Papeis de um usuario dentro de uma clinica.
 * Espelha o enum `public.clinic_role` no Postgres — se um mudar, o outro muda junto.
 */
export const CLINIC_ROLES = ['admin', 'attendant', 'professional'] as const

export const clinicRoleSchema = z.enum(CLINIC_ROLES)

export type ClinicRole = z.infer<typeof clinicRoleSchema>
