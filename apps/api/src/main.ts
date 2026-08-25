import 'reflect-metadata'
import './bootstrap-env'

import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { loadEnv } from './config/env'

async function bootstrap(): Promise<void> {
  const env = loadEnv()
  const app = await NestFactory.create(AppModule)

  app.setGlobalPrefix('api')
  app.enableCors({
    origin: env.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Clinic-Id'],
  })

  await app.listen(env.API_PORT)
  console.warn(`API ouvindo em http://localhost:${env.API_PORT}/api`)
}

void bootstrap()
