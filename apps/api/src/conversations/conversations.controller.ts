import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import {
  listConversationsQuerySchema,
  paginationQuerySchema,
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
 * BLOCO 1: SOMENTE LEITURA.
 *
 * Nao ha POST nem PATCH aqui de proposito. Toda escrita do Atendimento passa
 * por funcao controlada no banco (`authenticated` tem apenas SELECT nas tres
 * tabelas), e os endpoints que as chamam sao o Bloco 2.
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
}
