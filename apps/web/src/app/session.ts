import { redirect } from 'next/navigation'
import type { ClinicMembership, UserProfile } from '@clinicas/shared'
import { fetchMe, readActiveClinicCookie, resolveActiveClinicId } from '../lib/api'

export interface ActiveSession {
  profile: UserProfile
  memberships: ClinicMembership[]
  activeClinic: ClinicMembership
}

/**
 * Contexto exigido por toda tela interna: usuario + clinica ativa VALIDADA.
 *
 * Sem nenhuma membership o usuario cai no onboarding. Este e o unico lugar que
 * decide a clinica ativa, e ele sempre parte da lista vinda do servidor — nunca
 * do cookie sozinho.
 */
export async function requireActiveSession(): Promise<ActiveSession> {
  const me = await fetchMe()

  if (me.memberships.length === 0) {
    redirect('/onboarding')
  }

  const cookieValue = await readActiveClinicCookie()
  const activeClinicId = resolveActiveClinicId(me.memberships, cookieValue)
  const activeClinic = me.memberships.find((m) => m.clinicId === activeClinicId)

  if (!activeClinic) {
    redirect('/onboarding')
  }

  return { profile: me.profile, memberships: me.memberships, activeClinic }
}
