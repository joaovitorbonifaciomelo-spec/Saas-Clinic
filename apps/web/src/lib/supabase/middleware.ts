import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { getPublicEnv } from '../env'

/**
 * Rotas acessiveis sem sessao.
 *
 * `/` entrou aqui porque virou a pagina publica de apresentacao. E a UNICA
 * mudanca de protecao: continua valendo prefixo, entao nada abaixo de /dashboard,
 * /agenda ou /patients ficou aberto — `/` casa por igualdade exata (a checagem
 * de prefixo procura `//`, que nenhuma rota tem).
 */
const PUBLIC_PATHS = ['/', '/login', '/signup', '/auth']

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

/**
 * Identidade e contador desta instancia do proxy.
 *
 * Servem para distinguir invocacao fria de quente sem depender de header
 * proprietario da plataforma: numa instancia recem-criada o contador vale 1.
 */
const PROXY_INSTANCE = Math.random().toString(36).slice(2, 6)
let PROXY_INVOCATIONS = 0

/** Cookie que liga a instrumentacao. O mesmo usado pelo <meta name="x-perf">. */
const PERF_COOKIE = 'perf_debug'

/**
 * Anexa a medicao do proxy na resposta — SOMENTE quando o cookie `perf_debug`
 * esta presente.
 *
 * O gate importa: sem ele o header ia para todo visitante, e ninguem que usa a
 * clinica tem o que fazer com o numero de invocacoes de uma instancia da
 * funcao. Diagnostico e ferramenta de quem esta investigando, nao decoracao
 * permanente da resposta.
 *
 * Mesmo ligado, so sai DURACAO E CONTADOR: o `desc` carrega um identificador
 * aleatorio de instancia e o numero da invocacao — nada derivado de usuario,
 * sessao, clinica ou token.
 */
function comTiming(request: NextRequest, response: NextResponse, authMs: number): NextResponse {
  if (request.cookies.get(PERF_COOKIE)?.value !== '1') return response
  response.headers.set(
    'Server-Timing',
    `proxyauth;dur=${authMs};desc="${PROXY_INSTANCE}-inv${PROXY_INVOCATIONS}"`,
  )
  return response
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
  /*
   * LIBERACAO TEMPORARIA DE DIAGNOSTICO — SAI JUNTO COM A ROTA.
   *
   * Comparacao por IGUALDADE EXATA, de proposito, e fora do PUBLIC_PATHS.
   * PUBLIC_PATHS casa por prefixo (`startsWith(path + '/')`), entao um item la
   * abriria tambem tudo abaixo do caminho. Aqui nao existe "abaixo": so este
   * pathname, literal. `/api`, `/api/`, `/api/conversations` e ate
   * `/api/diag-cf/x` continuam protegidos.
   *
   * A saida acontece ANTES de criar o cliente Supabase: a rota de diagnostico
   * nao chega a tocar cookie, sessao ou auth — nao e "autenticacao dispensada",
   * e autenticacao que nunca roda.
   */
  if (request.nextUrl.pathname === '/api/diag-cf') {
    return NextResponse.next({ request })
  }

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

  /*
   * getUser() e nao getSession(): valida o token contra o servidor de auth.
   *
   * Cronometrado porque e uma ida a rede em TODA requisicao, inclusive nas RSC,
   * e precisamos saber quanto dela esta no ~1s extra que aparece em metade das
   * navegacoes. Sai so a duracao e um contador de invocacoes desta instancia —
   * nenhum dado de usuario, sessao ou clinica.
   */
  const tAuth = Date.now()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const authMs = Date.now() - tAuth
  PROXY_INVOCATIONS += 1

  const { pathname } = request.nextUrl

  if (!user && !isPublicPath(pathname)) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = '/login'
    redirectUrl.searchParams.set('next', pathname)
    return comTiming(request, NextResponse.redirect(redirectUrl), authMs)
  }

  if (user && (pathname === '/login' || pathname === '/signup')) {
    const redirectUrl = request.nextUrl.clone()
    redirectUrl.pathname = '/dashboard'
    redirectUrl.search = ''
    return comTiming(request, NextResponse.redirect(redirectUrl), authMs)
  }

  return comTiming(request, response, authMs)
}
