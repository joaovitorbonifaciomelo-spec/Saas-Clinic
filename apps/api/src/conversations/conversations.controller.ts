import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import {
  listConversationsQuerySchema,
  paginationQuerySchema,
  registerConversationSchema,
  registerManualMessageSchema,
  type RegisterConversationInput,
  type RegisterConversationResult,
  type RegisterManualMessageInput,
  type RegisterManualMessageResult,
  type ConversationDetail,
  type ConversationEventView,
  type ConversationListItem,
  type ListConversationsQuery,
  type Message,
  type Page,
  type PaginationQuery,
} from '@clinicas/shared'
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { ActiveClinicId } from '../clinics/active-clinic.decorator'
import { ClinicMembershipGuard } from '../clinics/clinic-membership.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { ConversationsService } from './conversations.service'

/**
 * Leitura (Bloco 1) e registro manual (Bloco 2).
 *
 * Toda escrita passa por funcao controlada no banco — `authenticated` tem
 * apenas SELECT nas tres tabelas. Nao ha INSERT nesta camada.
 *
 * AINDA NAO EXISTEM aqui os endpoints de controle (assumir, transferir,
 * liberar, mudar status, vincular paciente). Eles carregam concorrencia
 * otimistica por versao e sao o Bloco 3.
 */
@Controller('conversations')
@UseGuards(AuthGuard, ClinicMembershipGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @ActiveClinicId() clinicId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listConversationsQuerySchema)) query: ListConversationsQuery,
  ): Promise<Page<ConversationListItem>> {
    // `mine` resolve contra o id do JWT, nunca contra um parametro da URL.
    return this.conversations.list(clinicId, user.id, query)
  }

  @Get(':id')
  findOne(
    @ActiveClinicId() clinicId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ConversationDetail> {
    return this.conversations.findById(clinicId, user.id, id)
  }

  @Get(':id/messages')
  messages(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<Message>> {
    return this.conversations.listMessages(clinicId, id, query)
  }

  @Get(':id/events')
  events(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<ConversationEventView>> {
    return this.conversations.listEvents(clinicId, id, query)
  }

  /**
   * Registra uma conversa manual.
   *
   * DOIS STATUS, UM CORPO. Conversa nova responde 201; telefone que ja tem
   * thread responde 200 com a conversa existente e `created: false`. Nao e
   * 409: reaproveitar a thread e o comportamento correto, nao uma falha — a
   * atendente quer falar com aquela pessoa, e a tela abre a conversa que ja
   * existe. O status distingue os casos para quem lê HTTP; `created` distingue
   * para quem programa a tela.
   *
   * `@Res({ passthrough: true })` existe so para variar o codigo; o Nest
   * continua serializando o retorno normalmente.
   */
  @Post()
  async register(
    @ActiveClinicId() clinicId: string,
    @Body(new ZodValidationPipe(registerConversationSchema)) body: RegisterConversationInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RegisterConversationResult> {
    const resultado = await this.conversations.register(clinicId, body)
    response.status(resultado.created ? 201 : 200)
    return resultado
  }

  /**
   * REGISTRA uma mensagem que aconteceu fora do sistema. NAO ENVIA NADA.
   *
   * A rota se chama `messages` e o metodo se chama `register` — nunca `send` —
   * porque nenhum provedor e acionado aqui. O paciente nao recebe nada; o que
   * existe e uma anotacao de que a conversa aconteceu por telefone, balcao ou
   * WhatsApp pessoal. Confundir os dois faria a equipe acreditar que respondeu
   * alguem que nunca foi respondido.
   */
  @Post(':id/messages')
  @HttpCode(201)
  registerMessage(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(registerManualMessageSchema)) body: RegisterManualMessageInput,
  ): Promise<RegisterManualMessageResult> {
    return this.conversations.registerManualMessage(clinicId, id, body)
  }
}
