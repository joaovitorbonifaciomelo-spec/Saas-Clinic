/**
 * =============================================================================
 * GATE PERMANENTE DE PRIVILEGIOS
 * =============================================================================
 *
 * Os 24 testes de isolamento exercitam SELECT/INSERT/UPDATE/DELETE — as quatro
 * operacoes cobertas por RLS. Eles passariam com nota maxima mesmo que
 * `authenticated` tivesse TRUNCATE, porque TRUNCATE **nao passa por policy
 * nenhuma**: um usuario da Clinica A apagaria os dados de todos os tenants sem
 * violar uma unica regra de RLS.
 *
 * Foi exatamente isso que aconteceu na primeira aplicacao das migrations: a
 * plataforma do Supabase reconciliou default privileges concedendo ALL, e como
 * GRANT e aditivo, o excesso sobreviveu. So a introspeccao de catalogo pegou.
 *
 * Este arquivo transforma aquela verificacao em teste permanente, para que uma
 * regressao futura quebre a suite em vez de passar despercebida.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { loadIsolationEnv, parseDbConnection } from './helpers'

const TABLES = [
  'profiles',
  'clinics',
  'clinic_members',
  'patients',
  'professionals',
  'services',
  'professional_availability',
  'appointments',
] as const

/** Privilegios que `authenticated` nunca pode ter. Ver cabecalho. */
const FORBIDDEN_FOR_AUTHENTICATED = ['TRUNCATE', 'TRIGGER', 'REFERENCES'] as const

/** Matriz autoritativa: espelha as migrations 0003/0010 (policies) e 0007/0011 (grants). */
const EXPECTED_AUTHENTICATED: Record<string, string[]> = {
  profiles: ['SELECT', 'UPDATE'],
  clinics: ['SELECT', 'UPDATE'],
  clinic_members: ['SELECT'],
  patients: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  // Sem DELETE: desativa via `active` — apagar quebraria historico de agenda.
  professionals: ['INSERT', 'SELECT', 'UPDATE'],
  services: ['INSERT', 'SELECT', 'UPDATE'],
  // Configuracao operacional: pode ser removida.
  professional_availability: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  // Sem DELETE: cancela via status, para o historico continuar auditavel.
  appointments: ['INSERT', 'SELECT', 'UPDATE'],
}

/**
 * Policies esperadas POR TABELA, nao um total unico.
 *
 * Um total agregado esconderia dois erros que se cancelam — uma policy a menos
 * em `appointments` e uma a mais em `patients` somariam igual e passariam.
 */
const EXPECTED_POLICIES_BY_TABLE: Record<string, number> = {
  profiles: 2,
  clinics: 2,
  clinic_members: 1,
  patients: 4,
  professionals: 3,
  services: 3,
  professional_availability: 4,
  appointments: 3,
}

let client: pg.Client

beforeAll(async () => {
  loadIsolationEnv() // aplica a trava de ambiente antes de conectar
  const uri = process.env.SUPABASE_DB_URL
  if (!uri) throw new Error('SUPABASE_DB_URL ausente no .env.test.')

  client = new pg.Client({ ...parseDbConnection(uri), ssl: { rejectUnauthorized: false } })
  await client.connect()
}, 60_000)

afterAll(async () => {
  if (client) await client.end()
})

describe('Privilegios de tabela', () => {
  it.each(TABLES)('authenticated nao tem TRUNCATE, TRIGGER nem REFERENCES em %s', async (table) => {
    const { rows } = await client.query<{ priv: string; granted: boolean }>(
      `select p as priv, has_table_privilege('authenticated', $1, p) as granted
         from unnest($2::text[]) as p`,
      [`public.${table}`, [...FORBIDDEN_FOR_AUTHENTICATED]],
    )
    const held = rows.filter((r) => r.granted).map((r) => r.priv)
    expect(held).toEqual([])
  })

  it.each(TABLES)('authenticated tem exatamente a matriz planejada em %s', async (table) => {
    const { rows } = await client.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = $1 and grantee = 'authenticated'`,
      [table],
    )
    const actual = rows.map((r) => r.privilege_type).sort()
    expect(actual).toEqual([...EXPECTED_AUTHENTICATED[table]!].sort())
  })

  it.each(TABLES)('anon nao tem nenhum privilegio em %s', async (table) => {
    const { rows } = await client.query(
      `select privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = $1 and grantee = 'anon'`,
      [table],
    )
    expect(rows).toEqual([])
  })

  it('PUBLIC nao concede privilegio em nenhuma das tabelas', async () => {
    // PUBLIC e herdado por todo papel: um grant aqui alcancaria anon e
    // authenticated mesmo com os dois aparentemente limpos.
    const { rows } = await client.query(
      `select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = any($1) and grantee = 'PUBLIC'`,
      [[...TABLES]],
    )
    expect(rows).toEqual([])
  })
})

describe('Privilegios de schema', () => {
  it.each(['anon', 'authenticated'])('%s nao tem CREATE no schema public', async (role) => {
    const { rows } = await client.query<{ create_priv: boolean }>(
      `select has_schema_privilege($1, 'public', 'CREATE') as create_priv`,
      [role],
    )
    // CREATE permitiria criar objetos proprios e escapar do modelo de isolamento.
    expect(rows[0]!.create_priv).toBe(false)
  })

  it.each(['anon', 'authenticated', 'service_role'])(
    '%s mantem USAGE no schema public',
    async (role) => {
      const { rows } = await client.query<{ usage_priv: boolean }>(
        `select has_schema_privilege($1, 'public', 'USAGE') as usage_priv`,
        [role],
      )
      expect(rows[0]!.usage_priv).toBe(true)
    },
  )
})

describe('RLS e policies', () => {
  it.each(TABLES)('RLS continua habilitado em %s', async (table) => {
    const { rows } = await client.query<{ enabled: boolean }>(
      `select c.relrowsecurity as enabled from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1`,
      [table],
    )
    expect(rows[0]!.enabled).toBe(true)
  })

  it.each(TABLES)('%s tem exatamente as policies esperadas', async (table) => {
    const { rows } = await client.query(
      `select policyname from pg_policies where schemaname = 'public' and tablename = $1`,
      [table],
    )
    expect(rows).toHaveLength(EXPECTED_POLICIES_BY_TABLE[table]!)
  })

  it('clinic_members nao tem policy de escrita', async () => {
    const { rows } = await client.query(
      `select policyname from pg_policies
        where schemaname = 'public' and tablename = 'clinic_members' and cmd <> 'SELECT'`,
    )
    expect(rows).toEqual([])
  })

  it('auth.users tem exatamente o nosso trigger, com nome namespaced', async () => {
    const { rows } = await client.query<{ tgname: string }>(
      `select tgname from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal`,
    )
    expect(rows.map((r) => r.tgname)).toEqual(['clinic_saas_on_auth_user_created'])
  })
})
