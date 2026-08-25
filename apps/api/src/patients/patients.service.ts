import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import type { CreatePatientInput, Patient, UpdatePatientInput } from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'

interface PatientRow {
  id: string
  clinic_id: string
  name: string
  phone: string
  birth_date: string | null
  insurance_provider: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = 'id, clinic_id, name, phone, birth_date, insurance_provider, created_at, updated_at'

function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    name: row.name,
    phone: row.phone,
    birthDate: row.birth_date,
    insuranceProvider: row.insurance_provider,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

@Injectable()
export class PatientsService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  async list(clinicId: string): Promise<Patient[]> {
    const { data, error } = await this.supabase
      .from('patients')
      .select(COLUMNS)
      .eq('clinic_id', clinicId)
      .order('name', { ascending: true })

    if (error) throw mapPostgrestError(error)
    return (data as unknown as PatientRow[]).map(toPatient)
  }

  /**
   * Busca por id. O `.eq('clinic_id')` NAO e a protecao — o RLS ja e. Ele so
   * evita que um id valido de outra clinica da qual o usuario TAMBEM participe
   * vaze para a clinica ativa errada.
   *
   * Ausencia tratada aqui, sem regra global: paciente inexistente e paciente de
   * outro tenant produzem exatamente o mesmo 404, com o mesmo corpo. Nao
   * confirmamos a existencia de dado alheio.
   */
  async findById(clinicId: string, patientId: string): Promise<Patient> {
    const { data, error } = await this.supabase
      .from('patients')
      .select(COLUMNS)
      .eq('clinic_id', clinicId)
      .eq('id', patientId)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Paciente nao encontrado.')

    return toPatient(data as unknown as PatientRow)
  }

  async create(clinicId: string, input: CreatePatientInput): Promise<Patient> {
    // clinic_id vem do guard, nunca do corpo da requisicao.
    const { data, error } = await this.supabase
      .from('patients')
      .insert({
        clinic_id: clinicId,
        name: input.name,
        phone: input.phone,
        birth_date: input.birthDate ?? null,
        insurance_provider: input.insuranceProvider ?? null,
      })
      .select(COLUMNS)
      .single()

    if (error) throw mapPostgrestError(error)
    return toPatient(data as unknown as PatientRow)
  }

  /**
   * Atualizacao parcial. Tentar atualizar paciente de outro tenant afeta zero
   * linhas e retorna 404 — nunca 403: um 403 confirmaria que o registro existe.
   */
  async update(clinicId: string, patientId: string, input: UpdatePatientInput): Promise<Patient> {
    const patch: Record<string, unknown> = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.phone !== undefined) patch.phone = input.phone
    if (input.birthDate !== undefined) patch.birth_date = input.birthDate ?? null
    if (input.insuranceProvider !== undefined) {
      patch.insurance_provider = input.insuranceProvider ?? null
    }

    if (Object.keys(patch).length === 0) {
      return this.findById(clinicId, patientId)
    }

    const { data, error } = await this.supabase
      .from('patients')
      .update(patch)
      .eq('clinic_id', clinicId)
      .eq('id', patientId)
      .select(COLUMNS)
      .maybeSingle()

    if (error) throw mapPostgrestError(error)
    if (!data) throw new NotFoundException('Paciente nao encontrado.')

    return toPatient(data as unknown as PatientRow)
  }
}
