import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'

export interface AuthenticatedUser {
  id: string
  email: string
}

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser
}

/**
 * Valida o Bearer token contra o Supabase Auth e anexa o usuario a requisicao.
 *
 * TRADEOFF CONHECIDO: getUser() e uma chamada de rede por requisicao. Aceitavel
 * na v0.1 e correto por construcao (respeita revogacao de token imediatamente).
 * Quando virar gargalo, trocar por verificacao local da assinatura via JWKS.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>()
    const token = extractBearerToken(request.headers.authorization)

    if (!token) {
      throw new UnauthorizedException('Autenticacao necessaria.')
    }

    const { data, error } = await this.supabase.auth.getUser(token)

    if (error || !data.user) {
      throw new UnauthorizedException('Sessao invalida ou expirada.')
    }

    request.user = { id: data.user.id, email: data.user.email ?? '' }
    return true
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, value] = header.split(' ')
  if (!scheme || !value) return null
  if (scheme.toLowerCase() !== 'bearer') return null
  const token = value.trim()
  return token.length > 0 ? token : null
}
