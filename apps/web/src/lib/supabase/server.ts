import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { getPublicEnv } from '../env'

/**
 * Client de servidor, um por render. Implementa getAll/setAll conforme exige o
 * @supabase/ssr 0.12.x — as variantes get/set/remove estao depreciadas e a
 * propria doc da biblioteca avisa que implementa-las mal causa logout aleatorio
 * e sessao encerrada cedo.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies()
  const env = getPublicEnv()

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Server Component nao pode escrever cookie. O middleware ja cuida
          // do refresh da sessao, entao ignorar aqui e o comportamento correto
          // e documentado pelo @supabase/ssr.
        }
      },
    },
  })
}
