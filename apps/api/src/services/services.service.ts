import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import type { CreateServiceInput, Service, UpdateServiceInput } from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'

interface ServiceRow {
  id: string
  clinic_id: string
  name: string
  duration_minutes: number
  price_cents: number | null
  active: boolean
  created_at: string
  updated_at: string
}

const COLUMNS = 'id, clinic_id, name, duration_minutes, price_cents, active, created_at, updated_at'

function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    priceCents: row.price_cents,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

@Injectable()
export class ServicesService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  async list(clinicId: string, onlyActive: boolean): Promise<Service[]> {
    let query = this.supabase.from('services').select(COLUMNS).eq('clinic_id', clinicId)
    if (onlyActive) query = query.eq('active', true)

    const { data, error } = await query.order('name', { ascending: true })
    if (error) throw mapPostgrestError(error)
    return (data as unknown as ServiceRow[]).map(toService)
  }

  async findById(clinicId: string, id: string): Promise<Service> {
    const { data, error } = await this.supabase
      .from('services')
      .select(COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Servico nao encontrado.')
    return toService(data as unknown as ServiceRow)
  }

  async create(clinicId: string, input: CreateServiceInput): Promise<Service> {
    const { data, error } = await this.supabase
      .from('services')
      .insert({
        clinic_id: clinicId,
        name: input.name,
        duration_minutes: input.durationMinutes,
        price_cents: input.priceCents ?? null,
        active: input.active ?? true,
      })
      .select(COLUMNS)
      .single()

    if (error) throw mapPostgrestError(error)
    return toService(data as unknown as ServiceRow)
  }

  async update(clinicId: string, id: string, input: UpdateServiceInput): Promise<Service> {
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.durationMinutes !== undefined) patch.duration_minutes = input.durationMinutes
    if (input.priceCents !== undefined) patch.price_cents = input.priceCents ?? null
    if (input.active !== undefined) patch.active = input.active

    if (Object.keys(patch).length === 0) return this.findById(clinicId, id)

    const { data, error } = await this.supabase
      .from('services')
      .update(patch)
      .eq('clinic_id', clinicId)
      .eq('id', id)
      .select(COLUMNS)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Servico nao encontrado.')
    return toService(data as unknown as ServiceRow)
  }
}
