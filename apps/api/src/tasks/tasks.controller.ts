import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  assignTaskSchema,
  cancelTaskSchema,
  changeTaskDueSchema,
  completeTaskSchema,
  createTaskSchema,
  listTasksQuerySchema,
  paginationQuerySchema,
  releaseTaskSchema,
  reopenTaskSchema,
  transferTaskSchema,
  updateTaskDetailsSchema,
  type AssignTaskInput,
  type ChangeTaskDueInput,
  type CreateTaskInput,
  type ListTasksQuery,
  type Page,
  type PaginationQuery,
  type Task,
  type TaskControlInput,
  type TaskDetail,
  type TaskEventView,
  type TaskListItem,
  type TransferTaskInput,
  type UpdateTaskDetailsInput,
} from '@clinicas/shared'
import { AuthGuard, type AuthenticatedUser } from '../auth/auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { ActiveClinicId, ActiveClinicTimezone } from '../clinics/active-clinic.decorator'
import { ClinicMembershipGuard } from '../clinics/clinic-membership.guard'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { TasksService } from './tasks.service'

/**
 * Leitura de Pendencias.
 *
 * SOMENTE leitura: nao ha nenhum endpoint de escrita, e `authenticated` sequer
 * tem INSERT ou UPDATE nas tabelas — toda mutacao passara por RPC controlada,
 * numa rodada propria.
 *
 * O tenant vem do `ClinicMembershipGuard`, nunca de query param. `?clinicId=`
 * nao existe e nao deve passar a existir: seria transformar a barreira de
 * tenant num campo preenchido pelo cliente.
 */
@Controller('tasks')
@UseGuards(AuthGuard, ClinicMembershipGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /**
   * A consulta principal da tela.
   *
   * As sete visoes sao combinacoes destes filtros, e nao endpoints separados:
   *
   *   Atrasadas       status=open&due=overdue
   *   Hoje            status=open&due=today
   *   Proximas        status=open&due=upcoming
   *   Sem prazo       status=open&due=none
   *   Minhas          status=open&assignment=mine
   *   Sem responsavel status=open&assignment=unassigned
   *   Concluidas      status=completed
   */
  @Get()
  list(
    @ActiveClinicId() clinicId: string,
    @ActiveClinicTimezone() timezone: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listTasksQuerySchema)) query: ListTasksQuery,
  ): Promise<Page<TaskListItem>> {
    // O corte do dia sai do fuso da CLINICA. O relogio do navegador nao entra
    // nesta decisao em momento nenhum.
    return this.tasks.list(clinicId, user.id, timezone, query)
  }

  @Get(':id')
  findOne(
    @ActiveClinicId() clinicId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TaskDetail> {
    return this.tasks.findById(clinicId, user.id, id)
  }

  @Get(':id/events')
  events(
    @ActiveClinicId() clinicId: string,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Page<TaskEventView>> {
    return this.tasks.listEvents(clinicId, id, query)
  }

  /* =========================================================================
     Escrita

     Atos de dominio explicitos, um por rota. NAO existe `PATCH /tasks/:id`
     generico: um endpoint que aceita qualquer campo nao tem como saber qual
     evento gerar, e o historico passaria a dizer "algo mudou" em vez de
     "o prazo mudou". Cada rota aqui corresponde a uma RPC e a um evento.

     Toda operacao depois da criacao exige `expectedVersion` NO CORPO —
     nunca em query string, que e o lugar de dado que se cola em link e se
     reenvia sem querer.
     ====================================================================== */

  /**
   * 201 com a pendencia criada.
   *
   * NAO E IDEMPOTENTE nesta versao, e isso esta registrado como divida: um
   * retry depois de resposta perdida cria uma segunda pendencia. Bloquear
   * duplo clique na tela reduz o caso comum e NAO e garantia de rede.
   */
  /* 201 aqui e o unico: criar produz recurso novo. As outras oito mudam um
     recurso que ja existe, e o default 201 do @Post() do Nest faria a tela ler
     "criei algo" onde nada foi criado. */
  @Post()
  @HttpCode(201)
  create(
    @ActiveClinicId() clinicId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createTaskSchema)) body: CreateTaskInput,
  ): Promise<TaskDetail> {
    return this.tasks.create(clinicId, user.id, body)
  }

  @Patch(':id/details')
  updateDetails(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaskDetailsSchema)) body: UpdateTaskDetailsInput,
  ): Promise<Task> {
    return this.tasks.updateDetails(id, body)
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignTaskSchema)) body: AssignTaskInput,
  ): Promise<Task> {
    return this.tasks.assign(id, body)
  }

  @Post(':id/transfer')
  @HttpCode(200)
  transfer(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(transferTaskSchema)) body: TransferTaskInput,
  ): Promise<Task> {
    return this.tasks.transfer(id, body)
  }

  @Post(':id/release')
  @HttpCode(200)
  release(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(releaseTaskSchema)) body: TaskControlInput,
  ): Promise<Task> {
    return this.tasks.release(id, body)
  }

  @Patch(':id/due')
  setDue(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(changeTaskDueSchema)) body: ChangeTaskDueInput,
  ): Promise<Task> {
    return this.tasks.setDue(id, body)
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(completeTaskSchema)) body: TaskControlInput,
  ): Promise<Task> {
    return this.tasks.complete(id, body)
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelTaskSchema)) body: TaskControlInput,
  ): Promise<Task> {
    return this.tasks.cancel(id, body)
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reopenTaskSchema)) body: TaskControlInput,
  ): Promise<Task> {
    return this.tasks.reopen(id, body)
  }
}
