import { cache } from 'react'

/**
 * Instrumentacao de diagnostico do servidor.
 *
 * Existe para responder uma pergunta especifica com evidencia em vez de
 * palpite: as navegacoes se dividem em ~700ms e ~1.8s, e precisamos saber onde
 * esse segundo extra nasce.
 *
 * SO SAI DURACAO. Nunca token, nunca cookie, nunca id de usuario, clinica ou
 * paciente — os nomes das marcas sao fixos, escritos no codigo, e o valor e
 * sempre um numero em milissegundos.
 *
 * A saida so e emitida quando o cookie `perf_debug` esta presente, entao um
 * usuario comum nunca recebe nada disso. Nao ha env var envolvida porque nao
 * temos acesso ao painel da Vercel para ligar e desligar.
 */

/** Identidade desta instancia da funcao. Muda quando a Vercel cria outra. */
const INSTANCE = Math.random().toString(36).slice(2, 6)
const BOOTED_AT = Date.now()

/** Quantas requisicoes esta instancia ja atendeu. 1 = invocacao fria. */
let INVOCATIONS = 0

export interface PerfState {
  /** Numero desta requisicao NESTA instancia. */
  n: number
  startedAt: number
  marks: { name: string; ms: number }[]
}

/**
 * Estado por requisicao. `cache` do React garante um objeto por render do
 * servidor — nao ha estado compartilhado entre requisicoes alem do contador de
 * invocacoes, que e um inteiro sem qualquer relacao com o usuario.
 */
export const perfState = cache((): PerfState => {
  INVOCATIONS += 1
  return { n: INVOCATIONS, startedAt: Date.now(), marks: [] }
})

/** Cronometra uma promessa e registra a duracao sob um nome fixo. */
export async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  // Toca o estado ANTES de rodar: senao `startedAt` nasceria quando a primeira
  // chamada TERMINA, e `render` mediria so o que veio depois dela.
  try {
    perfState()
  } catch {
    // fora de render do servidor
  }
  const t0 = Date.now()
  try {
    return await run()
  } finally {
    try {
      perfState().marks.push({ name, ms: Date.now() - t0 })
    } catch {
      // Fora de um render do servidor `cache` nao tem escopo. Medir nunca pode
      // derrubar o que estava sendo medido.
    }
  }
}

/**
 * Resumo em uma linha: identidade da instancia, se foi invocacao fria, idade da
 * instancia e a duracao de cada chamada de rede feita neste render.
 */
export function perfSummary(): string {
  let s: PerfState
  try {
    s = perfState()
  } catch {
    return ''
  }
  const partes = [
    `inst=${INSTANCE}`,
    `inv=${s.n}`,
    `cold=${s.n === 1 ? 1 : 0}`,
    `age=${Date.now() - BOOTED_AT}`,
    `render=${Date.now() - s.startedAt}`,
    ...s.marks.map((m) => `${m.name}=${m.ms}`),
  ]
  return partes.join(';')
}
