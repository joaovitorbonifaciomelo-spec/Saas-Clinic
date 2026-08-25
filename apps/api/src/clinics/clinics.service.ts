import { Inject, Injectable } from '@nestjs/common'
import type { Clinic, ClinicMembership, ClinicRole, CreateClinicInput } from '@clinicas/shared'
import { SUPABASE_USER_CLIENT, type UserScopedClient } from '../supabase/supabase.types'
import { mapPostgrestError } from '../common/postgrest-error'

interface MembershipRow {
  clinic_id: string
  role: ClinicRole
  clinics: { id: string; name: string } | null
}

interface ClinicRow {
  id: string
  name: string
  created_at: string
}

@Injectable()
export class ClinicsService {
  constructor(@Inject(SUPABASE_USER_CLIENT) private readonly supabase: UserScopedClient) {}

  /**
   * Clinicas do usuario. Nao ha filtro por user_id na query de proposito: o RLS
   * ja restringe clinic_members ao proprio usuario. Filtrar aqui daria a falsa
   * impressao de que a seguranca mora no application code.
   */
  async listMemberships(): Promise<ClinicMembership[]> {
    const { data, error } = await this.supabase
      .from('clinic_members')
      .select('clinic_id, role, clinics ( id, name )')
      .order('created_at', { ascending: true })

    if (error) throw mapPostgrestError(error)

    return (data as unknown as MembershipRow[])
      .filter((row) => row.clinics !== null)
      .map((row) => ({
        clinicId: row.clinic_id,
        clinicName: row.clinics!.name,
        role: row.role,
      }))
  }

  /**
   * Onboarding. Passa pela RPC porque `clinics` nao tem policy de INSERT e
   * `clinic_members` nao tem policy de escrita: clinica e membership admin
   * nascem juntas, na mesma transacao, ou nao nascem.
   */
  async createClinic(input: CreateClinicInput): Promise<Clinic> {
    const { data, error } = await this.supabase
      .rpc('create_clinic_with_owner', { p_name: input.name })
      .single()

    if (error) throw mapPostgrestError(error)

    const row = data as unknown as ClinicRow
    return { id: row.id, name: row.name, createdAt: row.created_at }
  }
}
