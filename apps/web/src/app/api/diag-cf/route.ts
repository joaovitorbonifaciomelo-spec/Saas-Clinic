/**
 * ROTA TEMPORARIA DE DIAGNOSTICO — REMOVER APOS O TESTE.
 *
 * Existe para responder uma unica pergunta: o runtime da Vercel consegue
 * resolver e alcancar o Quick Tunnel da Cloudflare? O Tailscale Funnel nao
 * conseguia — `getaddrinfo ENOTFOUND` a partir de `iad1`, enquanto o mesmo nome
 * resolvia por DoH de dentro da propria funcao.
 *
 * O alvo e uma CONSTANTE. Nao vem de query string, header nem body: uma rota
 * que busca a URL que o chamador mandar e um proxy aberto, e um proxy aberto
 * publicado na Vercel e um problema maior do que o que ele veio diagnosticar.
 *
 * Sem JWT, sem cookie, sem Supabase, sem secret, sem header de autenticacao. O
 * alvo e `/api/health`, que nao consulta banco e nao devolve dado de ninguem.
 *
 * A resposta carrega so o que a medicao exige — ok, status, duracao, fase e
 * codigo do erro de transporte. Nao repassa corpo nem header externo.
 */

/** Alvo fixo. Constante, nunca parametro. */
const ALVO = 'https://contractor-pharmaceutical-monday-learning.trycloudflare.com/api/health'

/** Curto de proposito: o diagnostico nao pode ficar preso esperando. */
const TIMEOUT_MS = 5_000

type Erro = { fase: string; codigo: string }

/**
 * Traduz a falha para fase + codigo.
 *
 * `fetch` do Node rejeita com um `TypeError` generico e guarda a causa real em
 * `cause` — e a causa e que distingue "o nome nao resolve" de "conectou e o TLS
 * falhou", que e exatamente a distincao que este teste precisa fazer.
 */
function classificar(erro: unknown): Erro {
  if (erro instanceof DOMException && erro.name === 'TimeoutError') {
    return { fase: 'timeout', codigo: `abortado apos ${TIMEOUT_MS}ms` }
  }

  const causa = erro instanceof Error ? (erro.cause as { code?: unknown } | undefined) : undefined
  const codigo = typeof causa?.code === 'string' ? causa.code : null

  if (codigo === null) {
    return { fase: 'desconhecida', codigo: erro instanceof Error ? erro.name : 'nao-Error' }
  }

  // DNS: a assinatura da falha do Funnel.
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') return { fase: 'dns', codigo }

  if (
    codigo === 'UND_ERR_CONNECT_TIMEOUT' ||
    codigo === 'ECONNREFUSED' ||
    codigo === 'ECONNRESET' ||
    codigo === 'EHOSTUNREACH' ||
    codigo === 'ENETUNREACH' ||
    codigo === 'ETIMEDOUT'
  ) {
    return { fase: 'conexao', codigo }
  }

  // Codigos de TLS do OpenSSL/Node comecam por CERT_, ERR_TLS_ ou EPROTO.
  if (codigo.startsWith('CERT_') || codigo.startsWith('ERR_TLS') || codigo === 'EPROTO') {
    return { fase: 'tls', codigo }
  }

  return { fase: 'outra', codigo }
}

export async function GET() {
  const inicio = performance.now()

  try {
    const resposta = await fetch(ALVO, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const ms = Math.round(performance.now() - inicio)

    // Descarta o corpo sem ler: chegou resposta HTTP, que e o que interessa.
    // Deixar o corpo pendurado vaza a conexao no pool do runtime.
    await resposta.body?.cancel()

    return Response.json(
      { ok: resposta.ok, status: resposta.status, ms, erro: null },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (erro) {
    const ms = Math.round(performance.now() - inicio)
    return Response.json(
      { ok: false, status: null, ms, erro: classificar(erro) },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
}
