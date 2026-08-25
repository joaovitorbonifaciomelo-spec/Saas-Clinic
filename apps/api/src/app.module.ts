import { Module } from '@nestjs/common'
import { HealthController } from './common/health.controller'
import { SupabaseModule } from './supabase/supabase.module'
import { ClinicsModule } from './clinics/clinics.module'
import { PatientsModule } from './patients/patients.module'
import { MeModule } from './me/me.module'

@Module({
  imports: [SupabaseModule, ClinicsModule, PatientsModule, MeModule],
  controllers: [HealthController],
})
export class AppModule {}
