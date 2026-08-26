import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common'
import { CLINIC_HEADER } from '@clinicas/shared'
import type { RequestWithUser } from '../auth/auth.guard'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'

export interface RequestWithClinic extends RequestWithUser {
  clinicId?: string
  clinicTimezone?: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Extrai e valida a FORMA do header. Nao diz nada sobre permissao. */
export function readClinicHeader(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return null
  const trimmed = value.trim()
  return UUID_PATTERN.test(trimmed) ? trimmed : null
}

/**
 * Confirma que o usuario do JWT participa da clinica pedida no header X-Clinic-Id.
 *
 * O header vem do navegador, logo e dado hostil ate prova em contrario. A prova
 * e um SELECT em clinic_members que ja passa pelo RLS: se o usuario nao for
 * membro, a linha nao existe para ele e a requisicao morre aqui. E mesmo que
 * este guard fosse removido por engano, o RLS nas tabelas de dados negaria de
 * novo — sao duas barreiras independentes, nao uma repetida.
 */
@Injectable()
export class ClinicMembershipGuard implements CanActivate {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithClinic>()
    const clinicId = readClinicHeader(request.headers[CLINIC_HEADER])

    if (!clinicId) {
      throw new ForbiddenException('Clinica ativa nao informada.')
    }

    const { data, error } = await this.supabase
      .from('clinic_members')
      .select('clinic_id, clinics ( timezone )')
      .eq('clinic_id', clinicId)
      .maybeSingle()

    if (error || !data) {
      // Mesma resposta para "clinica nao existe" e "existe mas nao e sua":
      // nao confirmamos a existencia de tenants alheios.
      throw new ForbiddenException('Acesso negado a esta clinica.')
    }

    request.clinicId = clinicId
    // O fuso vem junto do membership para a agenda nao pagar outra consulta.
    request.clinicTimezone =
      (data as unknown as { clinics: { timezone: string } | null }).clinics?.timezone ??
      'America/Sao_Paulo'
    return true
  }
}
