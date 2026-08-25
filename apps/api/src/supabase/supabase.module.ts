import { Global, Module, Scope } from '@nestjs/common'
import { REQUEST } from '@nestjs/core'
import { createClient } from '@supabase/supabase-js'
import type { Request } from 'express'
import { loadEnv } from '../config/env'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from './supabase.types'

/**
 * Client Supabase criado POR REQUISICAO, carregando o Authorization do usuario.
 *
 * Consequencia central do desenho: toda query desta API chega ao Postgres como
 * o papel `authenticated` daquele usuario, entao o RLS decide o que ele ve.
 * A API nao filtra por clinic_id "na mao" e torce para nao esquecer um WHERE —
 * o banco recusa. Nao existe client service_role em lugar nenhum deste app.
 */
export const supabaseUserClientProvider = {
  provide: SUPABASE_USER_CLIENT,
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: Request): UserScopedClient => {
    // Lido aqui e nao no topo do modulo: assim o .env ja foi carregado e um
    // erro de configuracao aparece no boot, nao num import silencioso.
    const env = loadEnv()
    const authorization = request.headers.authorization ?? ''

    return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      global: { headers: authorization ? { Authorization: authorization } : {} },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  },
}

@Global()
@Module({
  providers: [supabaseUserClientProvider],
  exports: [SUPABASE_USER_CLIENT],
})
export class SupabaseModule {}
