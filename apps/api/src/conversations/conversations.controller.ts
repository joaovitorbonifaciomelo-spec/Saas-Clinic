import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import {
  listConversationsQuerySchema,
  paginationQuerySchema,
  assignConversationSchema,
  linkConversationPatientSchema,
  registerConversationSchema,
  registerManualMessageSchema,
  releaseConversationSchema,
  setConversationStatusSchema,
  transferConversationSchema,
  unlinkConversationPatientSchema,
  type AssignConversationInput,
  type Conversation,
  type LinkConversationPatientInput,
  type ReleaseConversationInput,
  type SetConversationStatusInput,
  type TransferConversationInput,
  type UnlinkConversationPatientInput,
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
 * Leitura, registro manual e controle do Atendimento.
 *
 * Toda escrita passa por funcao controlada no banco — `authenticated` tem
 * apenas SELECT nas tres tabelas. Nao ha INSERT nem UPDATE nesta camada.
 *
 * CONCORRENCIA: as operacoes de controle exigem `expectedVersion` e NAO fazem
 * "ler versao, depois escrever". O filtro por versao esta dentro do proprio
 * UPDATE, na RPC — sem janela entre leitura e escrita, que e onde duas
 * atendentes assumiriam a mesma conversa.
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

  /* -------------------------------------------------------------------------
     CONTROLE (Bloco 3)

     Todas carregam `expectedVersion` e todas respondem igual:
       200 ok | 409 conflito com o estado atual | 404 inexistente ou alheia

     Nenhuma aceita `clinicId` no corpo — a clinica vem do header ja validado.
  ------------------------------------------------------------------------- */

  /**
   * Assumir o atendimento.
   *
   * NAO ha campo de usuario no corpo: "assumir" e sempre atribuir a si mesmo, e
   * quem decide quem e "si mesmo" e o `auth.uid()` dentro da RPC. Aceitar um
   * userId aqui transformaria "assumir" em "atribuir a qualquer um", que e
   * outra operacao — e essa e a transferencia, com regra propria.
   */
  @Post(':id/assign')
  @HttpCode(200)
  assign(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignConversationSchema)) body: AssignConversationInput,
  ): Promise<Conversation> {
    return this.conversations.assign(clinicId, id, body.expectedVersion)
  }

  @Post(':id/transfer')
  @HttpCode(200)
  transfer(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(transferConversationSchema)) body: TransferConversationInput,
  ): Promise<Conversation> {
    return this.conversations.transfer(clinicId, id, body.expectedVersion, body.assigneeUserId)
  }

  @Post(':id/release')
  @HttpCode(200)
  release(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(releaseConversationSchema)) body: ReleaseConversationInput,
  ): Promise<Conversation> {
    return this.conversations.release(clinicId, id, body.expectedVersion)
  }

  @Patch(':id/status')
  setStatus(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setConversationStatusSchema)) body: SetConversationStatusInput,
  ): Promise<Conversation> {
    return this.conversations.setStatus(clinicId, id, body.expectedVersion, body.status)
  }

  @Post(':id/patient')
  @HttpCode(200)
  linkPatient(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(linkConversationPatientSchema))
    body: LinkConversationPatientInput,
  ): Promise<Conversation> {
    return this.conversations.linkPatient(clinicId, id, body.expectedVersion, body.patientId)
  }

  /**
   * Desvincular o paciente.
   *
   * A versao vem na QUERY, nao no corpo: corpo em DELETE nao atravessa proxies
   * de forma confiavel, e a garantia de concorrencia nao pode depender de uma
   * parte da requisicao que alguem no caminho pode descartar. Continua
   * obrigatoria — so muda o transporte.
   */
  @Delete(':id/patient')
  unlinkPatient(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(unlinkConversationPatientSchema))
    query: UnlinkConversationPatientInput,
  ): Promise<Conversation> {
    return this.conversations.unlinkPatient(clinicId, id, query.expectedVersion)
  }
}
