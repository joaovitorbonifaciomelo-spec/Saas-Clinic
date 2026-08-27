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
  'conversations',
  'messages',
  'conversation_events',
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
    // Atendimento: LE e nao ESCREVE. Toda escrita passa por funcao controlada,
    // porque um GRANT nao consegue expressar invariante (ver 0014).
    conversations: ['SELECT'],
    messages: ['SELECT'],
    conversation_events: ['SELECT'],
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
    conversations: [],
    messages: [],
    conversation_events: [],
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

/**
 * Matriz explicita de service_role. Vale para as 11 tabelas, sem excecao.
 *
 * As 0006, 0013 e 0015 usaram `grant all`, e `all` em tabela nao e um conjunto
 * abstrato: expande para os sete privilegios que a tabela suporta. As 0016 e
 * 0017 revogaram os tres excedentes. Este bloco existe para que a regressao
 * apareca aqui e nao numa leitura manual de ACL seis meses depois.
 *
 * TRUNCATE e o que mais pesa: nao e coberto por RLS, nao dispara trigger de
 * linha, e esvazia todos os tenants numa instrucao sem deixar rastro.
 *
 * NAO HA EXCECAO POR TABELA, de proposito. Se um dia alguma precisar de outro
 * privilegio, a lista abaixo vira um mapa por tabela e a excecao fica escrita
 * com o motivo ao lado — nunca um caso especial silencioso no meio do laco.
 */
const SERVICE_ROLE_MATRIZ = {
  SELECT: true,
  INSERT: true,
  UPDATE: true,
  DELETE: true,
  TRUNCATE: false,
  REFERENCES: false,
  TRIGGER: false,
}

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
  console.log(`    nenhum privilegio concedido a PUBLIC nas ${TABLES.length} tabelas (OK)`)
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
  // service_role nao e conferido aqui: a matriz celula a celula, mais adiante,
  // cobre as 11 tabelas e e mais estrita do que "tem os quatro de DML".
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
/**
 * Policies esperadas POR TABELA, nao um total unico.
 *
 * Um total agregado esconderia dois erros que se cancelam — uma policy a menos
 * em `appointments` e uma a mais em `patients` somariam igual e passariam.
 */
const EXPECTED_POLICIES_BY_TABLE = {
  profiles: 2,
  clinics: 2,
  clinic_members: 1,
  patients: 4,
  professionals: 3,
  services: 3,
  professional_availability: 4,
  appointments: 3,
  conversations: 1,
  messages: 1,
  conversation_events: 1,
}

console.log('')
for (const table of TABLES) {
  const actual = policies.rows.filter((row) => row.tablename === table).length
  const expected = EXPECTED_POLICIES_BY_TABLE[table]
  console.log(`    ${table.padEnd(26)} ${actual} policy(ies) (esperado ${expected})`)
  if (actual !== expected) {
    fail(`${table}: esperadas ${expected} policies, encontradas ${actual}`)
  }
}

// --- service_role nas tabelas do Atendimento ---------------------------------
console.log('')
console.log('  MATRIZ DE service_role (as 11 tabelas)')
console.log('  ' + '-'.repeat(64))
const privsMatriz = Object.keys(SERVICE_ROLE_MATRIZ)
console.log('    ' + 'tabela'.padEnd(28) + privsMatriz.map((p) => p.slice(0, 4).padEnd(7)).join(''))
for (const table of TABLES) {
  const linha = []
  for (const priv of privsMatriz) {
    const { rows } = await client.query(
      `select has_table_privilege('service_role', $1, $2) as ok`,
      [`public.${table}`, priv],
    )
    const efetivo = rows[0].ok
    const esperado = SERVICE_ROLE_MATRIZ[priv]
    linha.push((efetivo ? 'sim' : '-').padEnd(7))
    if (efetivo !== esperado) {
      fail(
        `service_role.${table}: ${priv} esperado ${esperado ? 'SIM' : 'nao'}, efetivo ${efetivo ? 'SIM' : 'nao'}`,
      )
    }
  }
  console.log('    ' + table.padEnd(28) + linha.join(''))
}

// --- EXECUTE nas funcoes do Atendimento --------------------------------------
/**
 * O default do PostgreSQL concede EXECUTE a PUBLIC em toda funcao nova. Uma
 * funcao que deveria ser interna fica exposta por omissao, nao por engano
 * visivel — por isso a lista negativa importa tanto quanto a positiva.
 */
const EXPOSED_FUNCTIONS = [
  'conversation_create_manual',
  'conversation_add_manual_message',
  'conversation_assign',
  'conversation_transfer',
  'conversation_release',
  'conversation_set_status',
  'conversation_link_patient',
  'conversation_unlink_patient',
  // Diretorio da equipe: leitura/UX. A autorizacao real continua na FK e nas
  // funcoes de controle; este so devolve nome para a tela.
  'clinic_member_directory',
]
const INTERNAL_FUNCTIONS = [
  'conversation_log_appointment',
  'conversation_row_json',
  'message_row_json',
  'conversation_conflict',
  // Predicado e trigger de occurred_at: sao a autoridade, e ninguem os chama
  // de fora. Expostos, so dariam superficie sem utilidade.
  'message_occurred_at_ok',
  'reject_future_occurred_at',
]

console.log('')
console.log('  EXECUTE NAS FUNCOES DO ATENDIMENTO')
console.log('  ' + '-'.repeat(64))
const fns = await client.query(
  `select p.proname, p.oid::regprocedure::text as sig,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any($1)
    order by p.proname`,
  [[...EXPOSED_FUNCTIONS, ...INTERNAL_FUNCTIONS]],
)
for (const row of fns.rows) {
  const esperado = EXPOSED_FUNCTIONS.includes(row.proname)
  console.log(
    `    ${row.proname.padEnd(34)} authenticated=${row.auth_exec ? 'SIM' : 'nao'}  anon=${row.anon_exec ? 'SIM' : 'nao'}  (esperado ${esperado ? 'exposta' : 'INTERNA'})`,
  )
  if (esperado && !row.auth_exec) fail(`${row.proname} deveria ser executavel por authenticated`)
  if (!esperado && row.auth_exec) fail(`${row.proname} NAO deveria estar exposta a authenticated`)
  if (row.anon_exec) fail(`${row.proname} executavel por anon`)
}
for (const nome of [...EXPOSED_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
  if (!fns.rows.some((r) => r.proname === nome)) fail(`funcao ausente no banco: ${nome}`)
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
