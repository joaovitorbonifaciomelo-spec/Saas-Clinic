import { BadRequestException } from '@nestjs/common'

/**
 * Cursor de paginacao por chave (keyset), nao por offset.
 *
 * A fila muda embaixo do leitor: cada mensagem que chega reordena a lista. Com
 * offset, uma conversa que sobe para o topo entre a pagina 1 e a 2 empurra
 * outra para baixo do corte, e essa outra nunca aparece — sem erro, sem aviso,
 * sem nada que denuncie a falta. O cursor ancora numa linha concreta, entao o
 * pior caso passa a ser repetir uma linha, e nao perde-la.
 *
 * O conteudo e opaco para o cliente de proposito: e detalhe de ordenacao, e nao
 * uma API paralela para ele montar consultas.
 */
export interface QueueCursor {
  /** Nulo e um valor legitimo: conversa sem mensagem ordena no fim. */
  lastMessageAt: string | null
  id: string
}

export interface TimeCursor {
  at: string
  id: string
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decode(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch (cause) {
    // O cursor vem da URL, logo e dado hostil. Cursor corrompido e 400 — nunca
    // "ignora e devolve a primeira pagina", que faria a UI repetir em silencio.
    throw new BadRequestException('Cursor invalido.', { cause })
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:?\d{2}|Z)$/

export function encodeQueueCursor(c: QueueCursor): string {
  return encode({ m: c.lastMessageAt, i: c.id })
}

export function decodeQueueCursor(raw: string): QueueCursor {
  const parsed = decode(raw) as { m?: unknown; i?: unknown }
  const lastMessageAt = parsed.m
  const id = parsed.i

  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new BadRequestException('Cursor invalido.')
  }
  if (lastMessageAt !== null && (typeof lastMessageAt !== 'string' || !ISO.test(lastMessageAt))) {
    throw new BadRequestException('Cursor invalido.')
  }

  return { lastMessageAt: lastMessageAt as string | null, id }
}

export function encodeTimeCursor(c: TimeCursor): string {
  return encode({ t: c.at, i: c.id })
}

export function decodeTimeCursor(raw: string): TimeCursor {
  const parsed = decode(raw) as { t?: unknown; i?: unknown }
  if (typeof parsed.t !== 'string' || !ISO.test(parsed.t)) {
    throw new BadRequestException('Cursor invalido.')
  }
  if (typeof parsed.i !== 'string' || !UUID.test(parsed.i)) {
    throw new BadRequestException('Cursor invalido.')
  }
  return { at: parsed.t, id: parsed.i }
}

/**
 * Traduz o cursor da fila para o filtro do PostgREST.
 *
 * A ordem e `last_message_at desc nulls last, id desc`, entao "depois do
 * cursor" tem tres casos, e o terceiro e o que costuma ser esquecido:
 *
 *   1. atividade estritamente menor;
 *   2. mesma atividade, id menor (desempate);
 *   3. atividade NULA — `lt` nao pega null em SQL, e sem este ramo a paginacao
 *      pararia exatamente na fronteira entre "ja teve mensagem" e "nunca teve",
 *      escondendo as conversas novas que ainda nao receberam nada.
 *
 * Quando o cursor JA esta no bloco dos nulos, so resta desempatar por id.
 */
export function queueCursorFilter(cursor: QueueCursor): string {
  if (cursor.lastMessageAt === null) {
    return `and(last_message_at.is.null,id.lt.${cursor.id})`
  }
  return [
    `last_message_at.lt.${cursor.lastMessageAt}`,
    `and(last_message_at.eq.${cursor.lastMessageAt},id.lt.${cursor.id})`,
    `last_message_at.is.null`,
  ].join(',')
}

/** Ordem cronologica crescente: `occurred_at asc, id asc`, sem nulos. */
export function timeCursorFilter(column: string, cursor: TimeCursor): string {
  return [`${column}.gt.${cursor.at}`, `and(${column}.eq.${cursor.at},id.gt.${cursor.id})`].join(
    ',',
  )
}
