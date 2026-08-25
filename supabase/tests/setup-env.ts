import { config as loadDotenv } from 'dotenv'
import { resolve } from 'node:path'

// .env.test e o UNICO arquivo que carrega credencial administrativa.
// Fica fora de apps/web e apps/api de proposito.
loadDotenv({ path: resolve(__dirname, '../../.env.test') })
