import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common'
import type { HttpException } from '@nestjs/common'

export interface PostgrestLikeError {
  code?: string
  message?: string
}

/**
 * Traduz erro do Postgres/PostgREST em excecao HTTP, sem repassar a mensagem
 * crua (que carrega nome de tabela, policy e constraint).
 *
 * NAO existe aqui regra generica de "resultado vazio -> 404". Resultado vazio
 * nem chega a ser erro no PostgREST, e transformar isso em 404 num interceptor
 * global mascararia bug de query como recurso inexistente. Ausencia e tratada
 * explicitamente em cada handler de recurso individual.
 */
export function mapPostgrestError(error: PostgrestLikeError | null): HttpException {
  const code = error?.code ?? ''

  switch (code) {
    // Violacao de policy de RLS numa ESCRITA (WITH CHECK) ou privilegio negado.
    case '42501':
      return new ForbiddenException('Operacao nao permitida.')
    // unique_violation
    case '23505':
      return new ConflictException('Registro duplicado.')
    // foreign_key_violation / check_violation / invalid_parameter / not_null
    case '23503':
    case '23514':
    case '23502':
    case '22023':
      return new BadRequestException('Dados invalidos.')
    default:
      return new InternalServerErrorException('Erro ao processar a requisicao.')
  }
}
