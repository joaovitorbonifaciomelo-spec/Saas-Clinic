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
  changeStatusSchema,
  createAppointmentSchema,
  updateAppointmentSchema,
  type AppointmentWithRelations,
  type Appointment,
  type ChangeStatusInput,
  type CreateAppointmentInput,
  type UpdateAppointmentInput,
} from '@clinicas/shared'
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { ActiveClinicId, ActiveClinicTimezone } from '../clinics/active-clinic.decorator'
import { ClinicMembershipGuard } from '../clinics/clinic-membership.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { AppointmentsService } from './appointments.service'

@Controller('appointments')
@UseGuards(AuthGuard, ClinicMembershipGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  list(
    @ActiveClinicId() clinicId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('professionalId') professionalId?: string,
    @Query('patientId') patientId?: string,
  ): Promise<AppointmentWithRelations[]> {
    return this.appointments.list(clinicId, { from, to, professionalId, patientId })
  }

  @Get(':id')
  findOne(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
  ): Promise<AppointmentWithRelations> {
    return this.appointments.findById(clinicId, id)
  }

  /** Pode responder 409 com os avisos; ver AppointmentsService.guardWarnings. */
  @Post()
  @HttpCode(201)
  create(
    @ActiveClinicId() clinicId: string,
    @ActiveClinicTimezone() timezone: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createAppointmentSchema)) body: CreateAppointmentInput,
  ): Promise<Appointment> {
    // created_by sai do JWT, nunca do corpo.
    return this.appointments.create(clinicId, user.id, timezone, body)
  }

  @Patch(':id')
  update(
    @ActiveClinicId() clinicId: string,
    @ActiveClinicTimezone() timezone: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAppointmentSchema)) body: UpdateAppointmentInput,
  ): Promise<Appointment> {
    return this.appointments.update(clinicId, id, timezone, body)
  }

  /** Rota estreita: so o enum, sem chance de alterar horario por engano. */
  @Patch(':id/status')
  changeStatus(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeStatusSchema)) body: ChangeStatusInput,
  ): Promise<Appointment> {
    return this.appointments.changeStatus(clinicId, id, body.status)
  }
}
