import { cache } from 'react'
import { cookies } from 'next/headers'
import { timed } from './perf'
import { CLINIC_HEADER, type MeResponse } from '@clinicas/shared'
import { getPublicEnv } from './env'
import { createSupabaseServerClient } from './supabase/server'

/**
 * Cookie de clinica ativa. Este e NOSSO cookie (nao da lib de auth), entao pode
 * e deve ser httpOnly. Ainda assim ele nunca e fonte de verdade: o valor e
 * revalidado contra as memberships a cada request em resolveActiveClinicId().
 */
export const ACTIVE_CLINIC_COOKIE = 'active_clinic_id'

/** Formato de UUID. Checagem de FORMA — nao tem nada a ver com autorizacao. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Palpite de clinica ativa vindo do cookie.
 *
 * DEVOLVE UM PALPITE, NAO UMA PERMISSAO. Serve unicamente para comecar as
 * buscas de dados em paralelo com /api/me em vez de depois dele. Valor ausente
 * ou fora do formato vira `undefined` e o fluxo segue pelo caminho normal.
 *
 * Quem autoriza continua sendo, em tres camadas independentes: o JWT do
 * usuario em toda chamada, o ClinicMembershipGuard na API e o RLS no Postgres.
 * Nenhuma delas olha para este cookie.
 */
export async function readClinicHint(): Promise<string | undefined> {
  const raw = await readActiveClinicCookie()
  return raw && UUID_RE.test(raw) ? raw : undefined
}

/**
 * Grava o palpite. So pode ser chamado de Server Action — o Next proibe
 * escrever cookie durante render, e com razao: escrever durante render torna a
 * resposta dependente de efeito colateral.
 */
export async function writeClinicHint(clinicId: string): Promise<void> {
  if (!UUID_RE.test(clinicId)) return
  const store = await cookies()
  store.set(ACTIVE_CLINIC_COOKIE, clinicId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
}

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

/**
 * Token de acesso, memoizado POR REQUISICAO.
 *
 * `apiFetch` chamava isto em toda ida a API — e a agenda dispara cinco em
 * paralelo. Eram cinco clientes Supabase construidos, cinco leituras de cookie
 * e, quando o token estava perto de expirar, cinco tentativas concorrentes de
 * refresh contra o servidor de auth para renovar a MESMA sessao.
 *
 * `cache` do React dedupa dentro de um unico render do servidor e nada alem
 * disso: nao ha estado entre requisicoes, entao um token nunca atravessa de um
 * usuario para outro.
 */
const getAccessToken = cache(async (): Promise<string | null> => {
  const supabase = await createSupabaseServerClient()
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? null
})

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

  // O nome da marca vem do caminho SEM query string e sem ids: /api/me,
  // /api/patients. Nunca entra identificador de recurso na medicao.
  const marca = path.split('?')[0]!.replace(/\/[0-9a-f-]{36}/gi, '/:id')

  const response = await timed(marca, () =>
    fetch(`${getPublicEnv().NEXT_PUBLIC_API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    }),
  )

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
