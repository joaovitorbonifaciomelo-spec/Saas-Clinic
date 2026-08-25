import { Module } from '@nestjs/common'
import { ClinicsModule } from '../clinics/clinics.module'
import { MeController } from './me.controller'

@Module({
  imports: [ClinicsModule],
  controllers: [MeController],
})
export class MeModule {}
