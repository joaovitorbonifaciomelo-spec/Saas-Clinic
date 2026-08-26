import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  createProfessionalSchema,
  replaceAvailabilitySchema,
  updateProfessionalSchema,
  type AvailabilityBlock,
  type CreateProfessionalInput,
  type Professional,
  type ReplaceAvailabilityInput,
  type UpdateProfessionalInput,
} from '@clinicas/shared'
import { AuthGuard } from '../auth/auth.guard'
import { ActiveClinicId } from '../clinics/active-clinic.decorator'
import { ClinicMembershipGuard } from '../clinics/clinic-membership.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { ProfessionalsService } from './professionals.service'

@Controller('professionals')
@UseGuards(AuthGuard, ClinicMembershipGuard)
export class ProfessionalsController {
  constructor(private readonly professionals: ProfessionalsService) {}

  @Get()
  list(
    @ActiveClinicId() clinicId: string,
    @Query('active') active?: string,
  ): Promise<Professional[]> {
    return this.professionals.list(clinicId, active === 'true')
  }

  @Get(':id')
  findOne(@ActiveClinicId() clinicId: string, @Param('id') id: string): Promise<Professional> {
    return this.professionals.findById(clinicId, id)
  }

  @Post()
  @HttpCode(201)
  create(
    @ActiveClinicId() clinicId: string,
    @Body(new ZodValidationPipe(createProfessionalSchema)) body: CreateProfessionalInput,
  ): Promise<Professional> {
    return this.professionals.create(clinicId, body)
  }

  @Patch(':id')
  update(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProfessionalSchema)) body: UpdateProfessionalInput,
  ): Promise<Professional> {
    return this.professionals.update(clinicId, id, body)
  }

  @Get(':id/availability')
  listAvailability(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
  ): Promise<AvailabilityBlock[]> {
    return this.professionals.listAvailability(clinicId, id)
  }

  /** PUT porque substitui a grade inteira, nao um bloco. */
  @Put(':id/availability')
  replaceAvailability(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replaceAvailabilitySchema)) body: ReplaceAvailabilityInput,
  ): Promise<AvailabilityBlock[]> {
    return this.professionals.replaceAvailability(clinicId, id, body)
  }
}
