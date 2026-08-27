import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { ClinicMembership, UserProfile } from '@clinicas/shared'
import {
  ApiError,
  fetchMe,
  readActiveClinicCookie,
  readClinicHint,
  resolveActiveClinicId,
} from '../lib/api'

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

/**
 * Carrega dados da clinica EM PARALELO com a resolucao da sessao.
 *
 * O problema: toda tela esperava /api/me terminar so para saber qual clinic_id
 * mandar no cabecalho das proximas chamadas. Duas idas e voltas em serie pelo
 * Funnel, ~250ms cada, em toda navegacao.
 *
 * A ideia: o cookie ja sabe (quase sempre) qual e a clinica. Entao disparamos
 * `carregar(palpite)` junto com /api/me e, quando a sessao chega, so
 * APROVEITAMOS o resultado se a clinica validada for exatamente a do palpite.
 *
 * POR QUE ISSO NAO ALARGA ACESSO, em duas travas independentes:
 *
 *  1. A chamada especulativa leva o JWT do proprio usuario. Se o palpite
 *     apontar para outra clinica, o ClinicMembershipGuard nega e o RLS nao
 *     devolveria linha nenhuma de qualquer forma. O cookie nao e credencial.
 *
 *  2. Mesmo que a camada 1 falhasse, o resultado especulativo so e usado
 *     quando `palpite === clinica validada pelo servidor`. Um cookie adulterado
 *     nao passa nem por engano: o dado seria descartado antes de virar tela.
 *
 * Cookie ausente, malformado, obsoleto ou de clinica sem vinculo caem todos no
 * mesmo lugar: o caminho normal, com a clinica que /api/me confirmou.
 */
export async function loadForActiveClinic<T>(
  carregar: (clinicId: string) => Promise<T>,
): Promise<{ session: ActiveSession; data: T; hintUsed: boolean }> {
  const palpite = await readClinicHint()
  const sessaoPromise = getActiveSession()

  /*
   * O `.then` com dois ramos anexa o tratamento de rejeicao NA HORA. Sem isso,
   * um palpite obsoleto viraria unhandled rejection antes de alguem dar await.
   */
  const especulativo = palpite
    ? carregar(palpite).then(
        (valor) => ({ ok: true as const, valor }),
        () => ({ ok: false as const, valor: undefined }),
      )
    : null

  const session = await sessaoPromise
  const clinicId = session.activeClinic.clinicId

  if (especulativo && palpite === clinicId) {
    const r = await especulativo
    if (r.ok) return { session, data: r.valor as T, hintUsed: true }
  }

  return { session, data: await carregar(clinicId), hintUsed: false }
}
