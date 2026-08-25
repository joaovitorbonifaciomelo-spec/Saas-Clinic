import type { ClinicMembership } from './clinic'
import type { UserProfile } from './auth'

/** Header por onde o cliente indica a clinica ativa. Sempre revalidado no servidor. */
export const CLINIC_HEADER = 'x-clinic-id'

/** Resposta de GET /me: quem sou eu e de quais clinicas participo. */
export interface MeResponse {
  profile: UserProfile
  memberships: ClinicMembership[]
}

/** Formato unico de erro devolvido pela API. Nunca carrega detalhe do Postgres. */
export interface ApiErrorBody {
  statusCode: number
  error: string
  message: string
}
