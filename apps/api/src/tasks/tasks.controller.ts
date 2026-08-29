import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import {
  listTasksQuerySchema,
  paginationQuerySchema,
  type ListTasksQuery,
  type Page,
  type PaginationQuery,
  type TaskDetail,
  type TaskEventView,
  type TaskListItem,
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
}
