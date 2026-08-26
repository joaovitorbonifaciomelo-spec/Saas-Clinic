import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  createServiceSchema,
  updateServiceSchema,
  type CreateServiceInput,
  type Service,
  type UpdateServiceInput,
} from '@clinicas/shared'
import { AuthGuard } from '../auth/auth.guard'
import { ActiveClinicId } from '../clinics/active-clinic.decorator'
import { ClinicMembershipGuard } from '../clinics/clinic-membership.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { ServicesService } from './services.service'

@Controller('services')
@UseGuards(AuthGuard, ClinicMembershipGuard)
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  list(@ActiveClinicId() clinicId: string, @Query('active') active?: string): Promise<Service[]> {
    return this.services.list(clinicId, active === 'true')
  }

  @Get(':id')
  findOne(@ActiveClinicId() clinicId: string, @Param('id') id: string): Promise<Service> {
    return this.services.findById(clinicId, id)
  }

  @Post()
  @HttpCode(201)
  create(
    @ActiveClinicId() clinicId: string,
    @Body(new ZodValidationPipe(createServiceSchema)) body: CreateServiceInput,
  ): Promise<Service> {
    return this.services.create(clinicId, body)
  }

  @Patch(':id')
  update(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateServiceSchema)) body: UpdateServiceInput,
  ): Promise<Service> {
    return this.services.update(clinicId, id, body)
  }
}
