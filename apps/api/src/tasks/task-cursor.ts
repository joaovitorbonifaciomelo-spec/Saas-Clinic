import { BadRequestException } from '@nestjs/common'
import {
  decodeTimeCursor,
  encodeTimeCursor,
  timeCursorFilter,
  type TimeCursor,
} from '../conversations/conversation-cursor'

/*
 * REUSO DELIBERADO, e nao dependencia de dominio.
 *
 * `encodeTimeCursor`/`decodeTimeCursor` sao infraestrutura de paginacao, nao
 * regra do Atendimento: eles validam formato de UUID e de instante ISO, e essa
 * validacao ja passou por revisao. Reescreve-la aqui criaria duas
 * implementacoes da mesma checagem, e uma delas envelheceria.
 *
 * O lugar certo desses helpers e `common/`. A mudanca fica para quando houver
 * um TERCEIRO consumidor — mover agora significaria tocar num modulo ja
 * aprovado numa rodada que e so de leitura.
 */

export type { TimeCursor }
export { encodeTimeCursor, decodeTimeCursor, timeCursorFilter }

/**
 * Cursor da fila por prazo.
 *
 * `dueAt` nulo e valor legitimo, e nao ausencia: pendencia sem prazo ordena por
 * ultimo. Guardar `null` explicitamente e o que permite paginar ATRAVES da
 * fronteira entre "tem prazo" e "nao tem".
 */
export interface DueCursor {
  dueAt: string | null
  id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:?\d{2}|Z)$/

export function encodeDueCursor(c: DueCursor): string {
  return Buffer.from(JSON.stringify({ d: c.dueAt, i: c.id }), 'utf8').toString('base64url')
}

export function decodeDueCursor(raw: string): DueCursor {
  let parsed: { d?: unknown; i?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch (cause) {
    // O cursor vem da URL: e dado hostil. Cursor corrompido e 400 — nunca
    // "ignora e devolve a primeira pagina", que faria a UI repetir em silencio.
    throw new BadRequestException('Cursor invalido.', { cause })
  }

  const { d, i } = parsed
  if (typeof i !== 'string' || !UUID.test(i)) throw new BadRequestException('Cursor invalido.')
  if (d !== null && (typeof d !== 'string' || !ISO.test(d))) {
    throw new BadRequestException('Cursor invalido.')
  }
  return { dueAt: d as string | null, id: i }
}

/**
 * "Depois do cursor" na ordem `due_at asc nulls last, id asc`.
 *
 * Tres ramos, e o terceiro e o que costuma faltar:
 *
 *   1. prazo estritamente maior;
 *   2. mesmo prazo, id maior — o desempate obrigatorio;
 *   3. prazo NULO. `gt` nao alcanca null em SQL, e sem este ramo a paginacao
 *      pararia exatamente na fronteira entre "tem prazo" e "sem prazo",
 *      escondendo TODAS as pendencias sem prazo — que sao justamente as que o
 *      modulo existe para nao deixar sumir.
 *
 * Quando o cursor ja esta no bloco dos nulos, so resta desempatar por id.
 */
export function dueCursorFilter(cursor: DueCursor): string {
  if (cursor.dueAt === null) {
    return `and(due_at.is.null,id.gt.${cursor.id})`
  }
  return [
    `due_at.gt.${cursor.dueAt}`,
    `and(due_at.eq.${cursor.dueAt},id.gt.${cursor.id})`,
    `due_at.is.null`,
  ].join(',')
}

/**
 * "Depois do cursor" numa ordem DESCENDENTE por instante — `completed_at desc,
 * id desc`.
 *
 * O helper existente cobre so a ordem crescente. As abas Concluidas e
 * Canceladas mostram o mais recente primeiro, e usar o filtro crescente ali
 * devolveria a pagina anterior em vez da proxima.
 */
export function timeCursorFilterDesc(column: string, cursor: TimeCursor): string {
  return [`${column}.lt.${cursor.at}`, `and(${column}.eq.${cursor.at},id.lt.${cursor.id})`].join(
    ',',
  )
}
