import { getPublicEnv } from '../../../lib/env'

/**
 * INSTRUMENTO TEMPORARIO DE DIAGNOSTICO — REMOVER APOS A RODADA.
 *
 * Existe porque nao ha acesso aos logs de runtime da Vercel por aqui, e o
 * erro real de rede so aparece de dentro da funcao que executa la. Sem isto, o
 * unico sinal disponivel e "500 com digest", que nao diz nada sobre a causa.
 *
 * O QUE ELE DEVOLVE: nome e codigo do erro, a cadeia de `cause` do undici,
 * tempos por fase e o status HTTP quando a resposta chega.
 *
 * O QUE ELE NUNCA DEVOLVE: corpo de resposta, cabecalhos, token, cookie,
 * chave, ou qualquer dado de paciente. As rotas testadas sao chamadas SEM
 * credencial — o que interessa aqui e o transporte, e /api/me sem token
 * devolvendo 401 ja prova que a conexao chegou ate a aplicacao.
 *
 * O caminho leva um token para nao ficar acessivel por acidente. Isto nao e
 * uma fronteira de seguranca: e para nao virar endpoint publico enquanto
 * existir.
 */

const TOKEN = 'r7k2p9x4m1'

interface Fase {
  rota: string
  status?: number
  ms: number
  erro?: string
  codigo?: string
  causa?: string[]
}

/** Desenrola a cadeia de `cause` — o undici guarda a causa real la dentro. */
function cadeiaDeCausas(e: unknown): string[] {
  const saida: string[] = []
  let atual: unknown = e
  let profundidade = 0
  while (atual && profundidade < 6) {
    const err = atual as { name?: string; code?: string; message?: string; cause?: unknown }
    const parte = [err.name, err.code, err.message].filter(Boolean).join(' / ')
    if (parte) saida.push(parte.slice(0, 200))
    atual = err.cause
    profundidade += 1
  }
  return saida
}

async function tentar(base: string, rota: string, timeoutMs: number): Promise<Fase> {
  const t0 = Date.now()
  try {
    const res = await fetch(`${base}${rota}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    // O corpo NAO e lido nem devolvido: so o status importa para o transporte.
    return { rota, status: res.status, ms: Date.now() - t0 }
  } catch (e) {
    const err = e as { name?: string; code?: string }
    return {
      rota,
      ms: Date.now() - t0,
      erro: err.name ?? 'Error',
      codigo: err.code,
      causa: cadeiaDeCausas(e),
    }
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params
  if (token !== TOKEN) {
    return new Response('não encontrado', { status: 404 })
  }

  const base = getPublicEnv().NEXT_PUBLIC_API_URL
  const anfitriao = (() => {
    try {
      return new URL(base).host
    } catch {
      return '(invalido)'
    }
  })()

  // 1. Uma chamada isolada.
  const isolada = await tentar(base, '/api/health', 20_000)

  // 2. Cinco em paralelo — o mesmo padrao da pagina da agenda.
  const t0 = Date.now()
  const paralelas = await Promise.all([
    tentar(base, '/api/health', 20_000),
    tentar(base, '/api/me', 20_000),
    tentar(base, '/api/professionals', 20_000),
    tentar(base, '/api/services?active=true', 20_000),
    tentar(base, '/api/patients', 20_000),
  ])
  const totalParalelas = Date.now() - t0

  // 3. Sequenciais, para separar concorrencia de instabilidade geral.
  const sequenciais: Fase[] = []
  for (const rota of ['/api/health', '/api/health', '/api/health']) {
    sequenciais.push(await tentar(base, rota, 20_000))
  }

  /*
   * CONTROLES. Sem eles, "ENOTFOUND" nao distingue tres coisas muito
   * diferentes: o DNS da funcao estar quebrado para tudo, estar quebrado so
   * para este dominio, ou a rede de saida bloquear o destino inteiro.
   */
  const controles = {
    // DNS em geral funciona? Dominio publico, estavel, sem relacao conosco.
    dnsGeral: await tentar('https://example.com', '/', 15_000),
    // O apex do provedor resolve? Separa "o dominio todo" de "este host".
    apexDoProvedor: await tentar('https://tailscale.com', '/', 15_000),
    /*
     * Alcanca o IP da borda sem passar por DNS? O certificado nao vai bater
     * com um IP, entao o erro esperado e de TLS — e um erro de TLS AQUI
     * prova que o pacote saiu e chegou. Recusa de conexao provaria bloqueio
     * de saida.
     */
    porIpSemDns: await tentar('https://209.177.145.97', '/api/health', 15_000),
  }

  return Response.json(
    {
      anfitriaoDaApi: anfitriao,
      regiao: process.env.VERCEL_REGION ?? '(desconhecida)',
      ambiente: process.env.VERCEL_ENV ?? '(desconhecido)',
      runtime: process.version,
      isolada,
      paralelas,
      totalParalelasMs: totalParalelas,
      sequenciais,
      controles,
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
