import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import type {
  AvailabilityBlock,
  CreateProfessionalInput,
  Professional,
  ReplaceAvailabilityInput,
  UpdateProfessionalInput,
} from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'

interface ProfessionalRow {
  id: string
  clinic_id: string
  name: string
  specialty: string | null
  active: boolean
  created_at: string
  updated_at: string
}

interface AvailabilityRow {
  id: string
  clinic_id: string
  professional_id: string
  weekday: number
  start_time: string
  end_time: string
  active: boolean
}

const COLUMNS = 'id, clinic_id, name, specialty, active, created_at, updated_at'
const AVAILABILITY_COLUMNS = 'id, clinic_id, professional_id, weekday, start_time, end_time, active'

function toProfessional(row: ProfessionalRow): Professional {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    name: row.name,
    specialty: row.specialty,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toBlock(row: AvailabilityRow): AvailabilityBlock {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    professionalId: row.professional_id,
    weekday: row.weekday,
    startTime: row.start_time,
    endTime: row.end_time,
    active: row.active,
  }
}

@Injectable()
export class ProfessionalsService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  async list(clinicId: string, onlyActive: boolean): Promise<Professional[]> {
    let query = this.supabase.from('professionals').select(COLUMNS).eq('clinic_id', clinicId)
    if (onlyActive) query = query.eq('active', true)

    const { data, error } = await query.order('name', { ascending: true })
    if (error) throw mapPostgrestError(error)
    return (data as unknown as ProfessionalRow[]).map(toProfessional)
  }

  async findById(clinicId: string, id: string): Promise<Professional> {
    const { data, error } = await this.supabase
      .from('professionals')
      .select(COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Profissional nao encontrado.')
    return toProfessional(data as unknown as ProfessionalRow)
  }

  async create(clinicId: string, input: CreateProfessionalInput): Promise<Professional> {
    const { data, error } = await this.supabase
      .from('professionals')
      .insert({
        clinic_id: clinicId,
        name: input.name,
        specialty: input.specialty ?? null,
        active: input.active ?? true,
      })
      .select(COLUMNS)
      .single()

    if (error) throw mapPostgrestError(error)
    return toProfessional(data as unknown as ProfessionalRow)
  }

  async update(
    clinicId: string,
    id: string,
    input: UpdateProfessionalInput,
  ): Promise<Professional> {
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.specialty !== undefined) patch.specialty = input.specialty ?? null
    if (input.active !== undefined) patch.active = input.active

    if (Object.keys(patch).length === 0) return this.findById(clinicId, id)

    const { data, error } = await this.supabase
      .from('professionals')
      .update(patch)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .select(COLUMNS)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Profissional nao encontrado.')
    return toProfessional(data as unknown as ProfessionalRow)
  }

  /**
   * Todos os blocos ativos da clinica, de todos os profissionais.
   *
   * Existe para a agenda conseguir marcar "fora do horario" em qualquer
   * agendamento sem depender de filtro de profissional. A alternativa seria uma
   * chamada por profissional (N+1) ou um badge que so aparece com filtro ativo —
   * meia-funcionalidade que confunde mais do que ajuda.
   */
  async listClinicAvailability(clinicId: string): Promise<AvailabilityBlock[]> {
    const { data, error } = await this.supabase
      .from('professional_availability')
      .select(AVAILABILITY_COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('active', true)
      .order('professional_id', { ascending: true })
      .order('weekday', { ascending: true })
      .order('start_time', { ascending: true })

    if (error) throw mapPostgrestError(error)
    return (data as unknown as AvailabilityRow[]).map(toBlock)
  }

  async listAvailability(clinicId: string, professionalId: string): Promise<AvailabilityBlock[]> {
    // Confirma que o profissional existe NESTA clinica antes de responder, para
    // que um id de outro tenant devolva 404 em vez de uma lista vazia — que
    // sugeriria "existe, mas sem horarios".
    await this.findById(clinicId, professionalId)

    const { data, error } = await this.supabase
      .from('professional_availability')
      .select(AVAILABILITY_COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('professional_id', professionalId)
      .order('weekday', { ascending: true })
      .order('start_time', { ascending: true })

    if (error) throw mapPostgrestError(error)
    return (data as unknown as AvailabilityRow[]).map(toBlock)
  }

  /**
   * Substitui a grade inteira do profissional.
   *
   * Apaga e reinsere em vez de reconciliar bloco a bloco: a tela edita a semana
   * como um todo, e diffs parciais so introduziriam estados intermediarios
   * estranhos sem nenhum ganho.
   */
  async replaceAvailability(
    clinicId: string,
    professionalId: string,
    input: ReplaceAvailabilityInput,
  ): Promise<AvailabilityBlock[]> {
    await this.findById(clinicId, professionalId)

    const { error: deleteError } = await this.supabase
      .from('professional_availability')
      .delete()
      .eq('clinic_id', clinicId)
      .eq('professional_id', professionalId)

    if (deleteError) throw mapPostgrestError(deleteError)

    if (input.blocks.length === 0) return []

    const { data, error } = await this.supabase
      .from('professional_availability')
      .insert(
        input.blocks.map((block) => ({
          clinic_id: clinicId,
          professional_id: professionalId,
          weekday: block.weekday,
          start_time: block.startTime,
          end_time: block.endTime,
          active: block.active ?? true,
        })),
      )
      .select(AVAILABILITY_COLUMNS)

    if (error) throw mapPostgrestError(error)
    return (data as unknown as AvailabilityRow[]).map(toBlock)
  }
}
