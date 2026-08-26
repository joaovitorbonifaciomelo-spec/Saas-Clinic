import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { ClinicMembership, UserProfile } from '@clinicas/shared'
import { ApiError, fetchMe, readActiveClinicCookie, resolveActiveClinicId } from '../lib/api'

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
  let me: Awaited<ReturnType<typeof fetchMe>>

  try {
    me = await fetchMe()
  } catch (error) {
    /*
     * Sessao expirada tem desfecho definido: volta para o login.
     *
     * Antes o ApiError subia e a rota protegida respondia 500 com stack trace —
     * o usuario via uma pagina de erro em vez de simplesmente ser deslogado.
     * O proxy cobre o caso de nao haver cookie nenhum; este catch cobre o token
     * que existe mas ja nao vale.
     *
     * So 401 e tratado. Qualquer outra falha continua subindo: esconder um erro
     * de infraestrutura atras de um redirect para /login transformaria "a API
     * caiu" em "voce foi deslogado", e o diagnostico ficaria impossivel.
     */
    if (error instanceof ApiError && error.status === 401) {
      redirect('/login')
    }
    throw error
  }

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

/**
 * Versao memoizada por requisicao.
 *
 * O shell (layout) e a pagina precisam do mesmo contexto. Sem `cache`, cada
 * render faria DUAS chamadas a /api/me — e cada ida e volta custa ~250ms pela
 * infraestrutura temporaria. O `cache` do React dedupa dentro do mesmo render,
 * entao colocar o nome da clinica na topbar sai de graca.
 */
export const getActiveSession = cache(requireActiveSession)
