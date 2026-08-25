import { z } from 'zod'

/**
 * Somente variaveis PUBLICAS. O prefixo NEXT_PUBLIC_ embute o valor no bundle
 * do navegador — por isso nenhum segredo pode passar por aqui. A anon key e
 * publica por design: sozinha ela nao da acesso a nada, quem decide o que ela
 * enxerga e o RLS.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url('NEXT_PUBLIC_SUPABASE_URL invalida.'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY ausente.'),
  NEXT_PUBLIC_API_URL: z.url('NEXT_PUBLIC_API_URL invalida.'),
})

export type PublicEnv = z.infer<typeof publicEnvSchema>

/**
 * Validado sob demanda, nao no import.
 *
 * Duas razoes: `next build` roda sem .env preenchido e nao deve quebrar por
 * isso; e um erro de configuracao aparece na requisicao, com mensagem util, em
 * vez de virar um crash opaco no carregamento do modulo.
 *
 * As variaveis sao lidas uma a uma e nao via process.env inteiro porque o Next
 * substitui `process.env.NEXT_PUBLIC_X` estaticamente no build — acesso
 * dinamico resultaria em undefined no navegador.
 */
export function getPublicEnv(): PublicEnv {
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  })

  if (!parsed.success) {
    // Apenas os NOMES das variaveis, nunca os valores.
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Variaveis de ambiente do frontend invalidas:\n${problems}`)
  }

  return parsed.data
}
