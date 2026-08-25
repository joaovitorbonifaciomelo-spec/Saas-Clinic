import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { AuthenticatedUser, RequestWithUser } from './auth.guard'

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>()
    if (!request.user) {
      // Chegar aqui significa controller sem AuthGuard: erro de programacao, nao de entrada.
      throw new Error('CurrentUser usado em rota sem AuthGuard.')
    }
    return request.user
  },
)
