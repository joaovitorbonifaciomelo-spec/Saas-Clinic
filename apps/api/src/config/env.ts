import { z } from 'zod'

/**
 * Ambiente da API. Note o que NAO esta aqui: SUPABASE_SERVICE_ROLE_KEY e
 * SUPABASE_DB_URL. A API nunca fala com o banco como service_role — se falasse,
 * bastaria um esquecimento para uma query passar por cima de todo o RLS.
 * Essas credenciais existem so no contexto administrativo/testes.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3333),
  SUPABASE_URL: z.url('SUPABASE_URL deve ser uma URL valida.'),
  SUPABASE_ANON_KEY: z.string().min(20, 'SUPABASE_ANON_KEY ausente ou invalida.'),
  WEB_ORIGIN: z.string().min(1).default('http://localhost:3000'),
})

export type ApiEnv = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    // Imprime apenas os NOMES das variaveis com problema. Jamais os valores:
    // log de erro e um vazamento de segredo esperando acontecer.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Variaveis de ambiente invalidas:\n${problems}`)
  }

  return parsed.data
}
