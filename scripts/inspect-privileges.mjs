#!/usr/bin/env node
/**
 * Introspeccao READ-ONLY dos privilegios efetivos e do estado do RLS.
 *
 * Confere o que o banco REALMENTE tem contra a matriz planejada, em vez de
 * confiar em que a migration fez o que dizia. Nao executa nenhum DDL/DML.
 *
 * Nunca imprime a connection string nem qualquer credencial.
 */
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadDotenv({ path: join(ROOT, '.env.test') })

const TABLES = [
  'profiles',
  'clinics',
  'clinic_members',
  'patients',
  'professionals',
  'services',
  'professional_availability',
  'appointments',
]

/** Matriz planejada: a mesma da migration 0003 (policies) e 0006 (grants). */
const EXPECTED = {
  authenticated: {
    profiles: ['SELECT', 'UPDATE'],
    clinics: ['SELECT', 'UPDATE'],
    clinic_members: ['SELECT'],
    patients: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    professionals: ['SELECT', 'INSERT', 'UPDATE'],
    services: ['SELECT', 'INSERT', 'UPDATE'],
    professional_availability: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    appointments: ['SELECT', 'INSERT', 'UPDATE'],
  },
  anon: {
    profiles: [],
    clinics: [],
    clinic_members: [],
    patients: [],
    professionals: [],
    services: [],
    professional_availability: [],
    appointments: [],
  },
}

const connectionString = process.env.SUPABASE_DB_URL
if (!connectionString) {
  console.error('SUPABASE_DB_URL ausente no .env.test.')
  process.exit(1)
}

/**
 * Campos discretos em vez da URI inteira.
 *
 * Senhas do Supabase costumam conter caracteres reservados no componente
 * userinfo de uma URI (`[`, `]`, `@`, `#`). O parser de connection string
 * normalizaria esses caracteres e a autenticacao falharia com 28P01 — que
 * parece "senha errada" mas e erro de parsing. Passar host/user/password
 * separados elimina a ambiguidade de encoding.
 */
function parseConnection(uri) {
  const match = /^postgresql:\/\/([^:]+):(.*)@([^/]+)\/(.+)$/.exec(uri)
  if (!match) {
    console.error('SUPABASE_DB_URL em formato inesperado.')
    process.exit(1)
  }
  const [, user, password, hostPort, database] = match
  const [host, port] = hostPort.split(':')
  return {
    user: decodeURIComponent(user),
    password: decodeURIComponent(password),
    host,
    port: Number(port ?? 5432),
    database: database.split('?')[0],
  }
}

const client = new pg.Client({
  ...parseConnection(connectionString),
  ssl: { rejectUnauthorized: false },
})
await client.connect()

let failures = 0
const fail = (message) => {
  failures += 1
  console.log(`    DIVERGENCIA: ${message}`)
}

// --- RLS ---------------------------------------------------------------------
console.log('\n  ESTADO DO RLS')
console.log('  ' + '-'.repeat(64))
const rls = await client.query(
  `select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
          (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any($1) order by c.relname`,
  [TABLES],
)
for (const row of rls.rows) {
  console.log(
    `    ${row.table.padEnd(16)} rls=${row.enabled ? 'ON ' : 'OFF'}  forced=${row.forced ? 'yes' : 'no '}  policies=${row.policies}`,
  )
  if (!row.enabled) fail(`RLS DESABILITADO em ${row.table}`)
}
if (rls.rows.length !== TABLES.length)
  fail(`esperadas ${TABLES.length} tabelas, achadas ${rls.rows.length}`)

// --- Privilegios efetivos ----------------------------------------------------
const grants = await client.query(
  `select grantee, table_name, privilege_type
     from information_schema.role_table_grants
    where table_schema = 'public' and table_name = any($1)
      and grantee in ('anon','authenticated','service_role')
    order by grantee, table_name, privilege_type`,
  [TABLES],
)

const byRole = {}
for (const row of grants.rows) {
  byRole[row.grantee] ??= {}
  byRole[row.grantee][row.table_name] ??= []
  byRole[row.grantee][row.table_name].push(row.privilege_type)
}

/**
 * Privilegios que `authenticated` NUNCA pode ter.
 *
 * TRUNCATE e o mais perigoso: RLS cobre SELECT/INSERT/UPDATE/DELETE e NAO cobre
 * TRUNCATE. Com esse privilegio, um usuario da Clinica A apaga os dados de todos
 * os tenants sem violar policy nenhuma — e nenhum dos 24 testes de isolamento
 * detectaria, porque eles exercitam apenas as quatro operacoes cobertas por RLS.
 * TRIGGER permitiria anexar gatilhos a tabelas compartilhadas.
 */
const FORBIDDEN_FOR_AUTHENTICATED = ['TRUNCATE', 'TRIGGER', 'REFERENCES']

console.log('\n  PRIVILEGIOS PROIBIDOS PARA authenticated')
console.log('  ' + '-'.repeat(64))
for (const table of TABLES) {
  const held = await client.query(
    `select p as priv, has_table_privilege('authenticated', $1, p) as granted
       from unnest($2::text[]) as p`,
    [`public.${table}`, FORBIDDEN_FOR_AUTHENTICATED],
  )
  const violations = held.rows.filter((r) => r.granted).map((r) => r.priv)
  console.log(
    `    ${table.padEnd(16)} ${violations.length === 0 ? 'nenhum dos proibidos (OK)' : 'POSSUI: ' + violations.join(', ')}`,
  )
  for (const priv of violations) fail(`authenticated tem ${priv} em ${table}`)
}

// --- PUBLIC ------------------------------------------------------------------
console.log('\n  PRIVILEGIOS VIA PUBLIC (papel implicito herdado por todos)')
console.log('  ' + '-'.repeat(64))
const publicGrants = await client.query(
  `select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public' and table_name = any($1) and grantee = 'PUBLIC'`,
  [TABLES],
)
if (publicGrants.rows.length === 0) {
  console.log('    nenhum privilegio concedido a PUBLIC nas 4 tabelas (OK)')
} else {
  for (const row of publicGrants.rows) fail(`PUBLIC tem ${row.privilege_type} em ${row.table_name}`)
}

// --- Schema ------------------------------------------------------------------
console.log('\n  PRIVILEGIOS DO SCHEMA public')
console.log('  ' + '-'.repeat(64))
const schemaPrivs = await client.query(
  `select r as role,
          has_schema_privilege(r, 'public', 'CREATE') as create_priv,
          has_schema_privilege(r, 'public', 'USAGE') as usage_priv
     from unnest(array['anon','authenticated','service_role']) as r`,
)
for (const row of schemaPrivs.rows) {
  console.log(
    `    ${row.role.padEnd(16)} CREATE=${row.create_priv ? 'SIM' : 'nao'}   USAGE=${row.usage_priv ? 'sim' : 'nao'}`,
  )
  // CREATE no schema permitiria criar objetos e escapar do modelo de isolamento.
  if (row.create_priv && row.role !== 'service_role') {
    fail(`${row.role} tem CREATE no schema public`)
  }
  if (!row.usage_priv) fail(`${row.role} sem USAGE no schema public`)
}

for (const role of ['anon', 'authenticated', 'service_role']) {
  console.log(`\n  PRIVILEGIOS EFETIVOS - ${role}`)
  console.log('  ' + '-'.repeat(64))
  for (const table of TABLES) {
    const actual = (byRole[role]?.[table] ?? []).sort()
    console.log(`    ${table.padEnd(16)} ${actual.length ? actual.join(', ') : '(nenhum)'}`)

    const expected = EXPECTED[role]?.[table]
    if (expected) {
      const want = [...expected].sort()
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        fail(`${role}.${table}: esperado [${want.join(', ')}], efetivo [${actual.join(', ')}]`)
      }
    }
  }
  if (role === 'service_role') {
    for (const table of TABLES) {
      const actual = byRole[role]?.[table] ?? []
      for (const needed of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        if (!actual.includes(needed))
          fail(`service_role.${table} sem ${needed} (uso administrativo)`)
      }
    }
  }
}

// --- Policies ----------------------------------------------------------------
console.log('\n  POLICIES POR TABELA')
console.log('  ' + '-'.repeat(64))
const policies = await client.query(
  `select tablename, policyname, cmd, roles::text
     from pg_policies where schemaname = 'public' and tablename = any($1)
    order by tablename, cmd, policyname`,
  [TABLES],
)
for (const row of policies.rows) {
  console.log(
    `    ${row.tablename.padEnd(16)} ${row.cmd.padEnd(6)} ${row.policyname}  roles=${row.roles}`,
  )
}

const writePolicies = policies.rows.filter(
  (r) => r.tablename === 'clinic_members' && r.cmd !== 'SELECT',
)
if (writePolicies.length > 0) {
  fail(`clinic_members tem policy de escrita: ${writePolicies.map((r) => r.policyname).join(', ')}`)
}

// As 9 policies da migration 0003. Perder uma abriria acesso; ganhar uma que nao
// esteja no arquivo significa que alguem mexeu no banco fora das migrations.
const EXPECTED_POLICY_COUNT = 23
console.log(`\n    total de policies: ${policies.rows.length} (esperado ${EXPECTED_POLICY_COUNT})`)
if (policies.rows.length !== EXPECTED_POLICY_COUNT) {
  fail(`esperadas ${EXPECTED_POLICY_COUNT} policies, encontradas ${policies.rows.length}`)
}

// --- Trigger em auth.users ---------------------------------------------------
const trigger = await client.query(
  `select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal`,
)
console.log('\n  TRIGGERS EM auth.users')
console.log('  ' + '-'.repeat(64))
for (const row of trigger.rows) console.log(`    ${row.tgname}`)

await client.end()

console.log('\n  ' + '='.repeat(64))
if (failures > 0) {
  console.log(`  RESULTADO: ${failures} DIVERGENCIA(S) em relacao a matriz planejada.\n`)
  process.exit(1)
}
console.log('  RESULTADO: privilegios efetivos batem com a matriz planejada.\n')
