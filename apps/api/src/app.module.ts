import { Module } from '@nestjs/common'
import { HealthController } from './common/health.controller'
import { SupabaseModule } from './supabase/supabase.module'
import { ClinicsModule } from './clinics/clinics.module'
import { PatientsModule } from './patients/patients.module'
import { MeModule } from './me/me.module'
import { ProfessionalsModule } from './professionals/professionals.module'
import { ServicesModule } from './services/services.module'
import { AppointmentsModule } from './appointments/appointments.module'
import { ConversationsModule } from './conversations/conversations.module'
import { TasksModule } from './tasks/tasks.module'

@Module({
  imports: [
    SupabaseModule,
    ClinicsModule,
    PatientsModule,
    MeModule,
    ProfessionalsModule,
    ServicesModule,
    AppointmentsModule,
    ConversationsModule,
    TasksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
