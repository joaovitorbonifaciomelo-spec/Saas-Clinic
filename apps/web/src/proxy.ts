import type { NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

/**
 * Convencao do Next 16: o arquivo se chama `proxy.ts`, o export se chama
 * `proxy`, e ele fica no mesmo nivel de `app` — aqui, dentro de `src/`.
 *
 * Antes estava como `middleware.ts` na raiz de apps/web, nome e local da
 * convencao antiga. O build reportava "Proxy (Middleware)" como se estivesse
 * tudo certo, mas em dev ele nunca executava: rotas protegidas devolviam 500 em
 * vez de redirecionar para /login. Os testes nao pegaram porque exercitam banco
 * e API, nunca a navegacao do browser.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: [
    /*
     * Tudo, exceto assets estaticos e imagens — rodar o refresh de sessao neles
     * so gastaria requisicao ao Supabase.
     */
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
