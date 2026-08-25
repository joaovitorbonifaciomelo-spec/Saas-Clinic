import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { getPublicEnv } from '../env'

/** Rotas acessiveis sem sessao. */
const PUBLIC_PATHS = ['/login', '/signup', '/auth']

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

/**
 * Refresh da sessao + protecao de rota.
 *
 * O padrao do @supabase/ssr exige que a MESMA resposta usada no setAll seja a
 * retornada, senao os cookies renovados se perdem e o usuario e deslogado do
 * nada. Por isso `response` e reatribuido dentro do setAll em vez de criado no
 * fim.
 *
 * Esta e uma barreira de NAVEGACAO, nao de dados: ela decide qual tela mostrar.
 * A protecao dos dados em si e do RLS no Postgres.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const env = getPublicEnv()
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // getUser() e nao getSession(): valida o token contra o servidor de auth.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = '/login'
    redirectUrl.searchParams.set('next', pathname)
    return NextResponse.redirect(redirectUrl)
  }

  if (user && (pathname === '/login' || pathname === '/signup')) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = '/dashboard'
    redirectUrl.search = ''
    return NextResponse.redirect(redirectUrl)
  }

  return response
}
