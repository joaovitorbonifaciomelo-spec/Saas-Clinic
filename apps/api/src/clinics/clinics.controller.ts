import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'
import { createClinicSchema, type Clinic, type ClinicMembership } from '@clinicas/shared'
import type { CreateClinicInput } from '@clinicas/shared'
import { AuthGuard } from '../auth/auth.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { ClinicsService } from './clinics.service'

@Controller('clinics')
@UseGuards(AuthGuard)
export class ClinicsController {
  constructor(private readonly clinics: ClinicsService) {}

  @Get()
  list(): Promise<ClinicMembership[]> {
    return this.clinics.listMemberships()
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createClinicSchema)) body: CreateClinicInput,
  ): Promise<Clinic> {
    return this.clinics.createClinic(body)
  }
}
