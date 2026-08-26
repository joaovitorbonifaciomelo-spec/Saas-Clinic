import { cookies } from 'next/headers'
import { CLINIC_HEADER, type MeResponse } from '@clinicas/shared'
import { getPublicEnv } from './env'
import { createSupabaseServerClient } from './supabase/server'

/**
 * Cookie de clinica ativa. Este e NOSSO cookie (nao da lib de auth), entao pode
 * e deve ser httpOnly. Ainda assim ele nunca e fonte de verdade: o valor e
 * revalidado contra as memberships a cada request em resolveActiveClinicId().
 */
export const ACTIVE_CLINIC_COOKIE = 'active_clinic_id'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Corpo bruto da resposta. O 409 da agenda carrega avisos e fingerprint. */
    readonly payload?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function getAccessToken(): Promise<string | null> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? null
}

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  clinicId?: string
}

/**
 * Chamada server-side a API NestJS, repassando o JWT do usuario. O token nunca
 * transita pelo componente cliente: quem fala com a API e o servidor do Next.
 */
export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const token = await getAccessToken()
  if (!token) throw new ApiError(401, 'Sessao expirada.')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  if (options.clinicId) headers[CLINIC_HEADER] = options.clinicId

  const response = await fetch(`${getPublicEnv().NEXT_PUBLIC_API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null
    throw new ApiError(response.status, payload?.message ?? 'Falha na requisicao.', payload)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function fetchMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/api/me')
}

/**
 * Decide qual clinica esta ativa.
 *
 * O cookie e apenas uma PREFERENCIA. Se apontar para uma clinica que nao esta
 * nas memberships — cookie forjado, acesso revogado, clinica removida —, ele e
 * descartado silenciosamente e caimos na primeira clinica valida. Nunca
 * devolvemos um clinic_id que o usuario nao possua.
 */
export function resolveActiveClinicId(
  memberships: MeResponse['memberships'],
  cookieValue: string | undefined,
): string | null {
  if (memberships.length === 0) return null
  if (cookieValue && memberships.some((m) => m.clinicId === cookieValue)) {
    return cookieValue
  }
  return memberships[0]?.clinicId ?? null
}

export async function readActiveClinicCookie(): Promise<string | undefined> {
  const store = await cookies()
  return store.get(ACTIVE_CLINIC_COOKIE)?.value
}
