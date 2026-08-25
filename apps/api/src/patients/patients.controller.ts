import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common'
import {
  createPatientSchema,
  updatePatientSchema,
  type CreatePatientInput,
  type Patient,
  type UpdatePatientInput,
} from '@clinicas/shared'
import { AuthGuard } from '../auth/auth.guard'
import { ActiveClinicId } from '../clinics/active-clinic.decorator'
import { ClinicMembershipGuard } from '../clinics/clinic-membership.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { type PatientsService } from './patients.service'

/**
 * Ordem dos guards importa: AuthGuard resolve QUEM e o usuario,
 * ClinicMembershipGuard resolve EM QUAL clinica ele esta agindo.
 */
@Controller('patients')
@UseGuards(AuthGuard, ClinicMembershipGuard)
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @Get()
  list(@ActiveClinicId() clinicId: string): Promise<Patient[]> {
    return this.patients.list(clinicId)
  }

  @Get(':id')
  findOne(@ActiveClinicId() clinicId: string, @Param('id') id: string): Promise<Patient> {
    return this.patients.findById(clinicId, id)
  }

  @Post()
  @HttpCode(201)
  create(
    @ActiveClinicId() clinicId: string,
    @Body(new ZodValidationPipe(createPatientSchema)) body: CreatePatientInput,
  ): Promise<Patient> {
    return this.patients.create(clinicId, body)
  }

  @Patch(':id')
  update(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePatientSchema)) body: UpdatePatientInput,
  ): Promise<Patient> {
    return this.patients.update(clinicId, id, body)
  }
}
