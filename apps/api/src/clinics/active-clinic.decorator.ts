import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { RequestWithClinic } from './clinic-membership.guard'

export const ActiveClinicId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<RequestWithClinic>()
    if (!request.clinicId) {
      throw new Error('ActiveClinicId usado em rota sem ClinicMembershipGuard.')
    }
    return request.clinicId
  },
)
