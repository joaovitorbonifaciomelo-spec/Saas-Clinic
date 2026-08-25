import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

// .env.test e o UNICO arquivo que carrega credencial administrativa.
// Fica fora de apps/web e apps/api de proposito.
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.test') })
