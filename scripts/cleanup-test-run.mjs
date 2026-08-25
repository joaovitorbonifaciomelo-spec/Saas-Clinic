#!/usr/bin/env node
/**
 * Limpeza explicita de uma execucao interrompida do teste de isolamento.
 *
 *   pnpm test:isolation:cleanup <test_run_id>
 *   pnpm test:isolation:cleanup --list
 *
 * Apaga EXCLUSIVAMENTE os IDs registrados no manifesto daquela execucao. Nao
 * existe busca por nome, prefixo, `like` ou `delete where` — se o manifesto nao
 * listar o recurso, este script nao o toca. Um residuo de teste esquecido custa
 * muito menos do que uma query de limpeza que alcance dado legitimo.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { config as loadDotenv } from 'dotenv'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_DIR = join(ROOT, 'supabase', 'tests', '.runs')

loadDotenv({ path: join(ROOT, '.env.test') })

function listRuns() {
  if (!existsSync(MANIFEST_DIR)) {
    console.log('Nenhum manifesto pendente.')
    return
  }
  const files = readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.json'))
  if (files.length === 0) {
    console.log('Nenhum manifesto pendente.')
    return
  }
  console.log('Execucoes com residuo pendente:\n')
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, file), 'utf8'))
    console.log(`  ${manifest.testRunId}`)
    console.log(`    criado em : ${manifest.createdAt}`)
    console.log(`    projeto   : ${manifest.supabaseUrl}`)
    console.log(`    usuarios  : ${manifest.userIds.length}`)
    console.log(`    clinicas  : ${manifest.clinicIds.length}\n`)
  }
}

/** UUID v4 canonico. Qualquer outra coisa e recusada. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Recusa tudo que nao seja um test_run_id exato.
 *
 * Alem de barrar coringa e "limpar tudo", isto fecha travessia de caminho: sem
 * validacao, `../../algo` sairia de MANIFEST_DIR e faria o script obedecer a um
 * arquivo arbitrario.
 */
function assertValidTestRunId(value) {
  const forbidden = ['--all', '-a', 'all', '*', '.', '..']
  if (forbidden.includes(value.toLowerCase())) {
    console.error(`Recusado: "${value}".`)
    console.error(
      'Nao existe modo "limpar todos". Cada execucao e limpa individualmente pelo seu test_run_id.',
    )
    console.error('Rode com --list para ver as execucoes pendentes.')
    process.exit(1)
  }

  if (!UUID_V4.test(value)) {
    console.error(`test_run_id invalido: "${value}".`)
    console.error('Deve ser o UUID exato de UMA execucao (veja --list).')
    process.exit(1)
  }
}

/**
 * Trava de ambiente. Roda ANTES de ler manifesto ou tocar em qualquer coisa:
 * uma credencial de producao herdada do shell precisa ser barrada no primeiro
 * passo, nao depois que o script ja comecou a agir.
 */
function requireTestEnvironment() {
  const environment = process.env.SUPABASE_TEST_ENVIRONMENT

  if (environment !== 'development' && environment !== 'staging') {
    console.error(
      `SUPABASE_TEST_ENVIRONMENT deve ser development ou staging ` +
        `(recebido: ${environment ?? 'nao definido'}).`,
    )
    console.error(
      'Este script remove usuarios e clinicas com service_role e NUNCA deve rodar contra producao.',
    )
    process.exit(1)
  }

  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorias no .env.test.')
    process.exit(1)
  }

  return { url, serviceRoleKey, environment }
}

async function cleanup(testRunId) {
  assertValidTestRunId(testRunId)
  const { url, serviceRoleKey, environment } = requireTestEnvironment()

  const manifestPath = join(MANIFEST_DIR, `${testRunId}.json`)
  if (!existsSync(manifestPath)) {
    console.error(`Manifesto nao encontrado: ${manifestPath}`)
    console.error('Rode com --list para ver as execucoes pendentes.')
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  // O manifesto guarda contra qual projeto os recursos foram criados. Limpar
  // IDs de um projeto usando as credenciais de outro seria apagar as linhas
  // erradas caso os UUIDs coincidissem.
  if (manifest.supabaseUrl !== url) {
    console.error(
      `Manifesto pertence a ${manifest.supabaseUrl}, mas o .env.test aponta para ${url}.`,
    )
    process.exit(1)
  }

  console.log(`Ambiente declarado : ${environment}`)
  console.log(`Projeto            : ${url}`)
  console.log(
    `Alvo               : ${manifest.userIds.length} usuario(s), ${manifest.clinicIds.length} clinica(s)`,
  )

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log(`Limpando execucao ${testRunId}...`)
  const problems = []

  if (manifest.clinicIds.length > 0) {
    // Clinicas primeiro: cascateia pacientes e memberships.
    const { error } = await admin.from('clinics').delete().in('id', manifest.clinicIds)
    if (error) problems.push(`clinicas: ${error.message}`)
    else console.log(`  ${manifest.clinicIds.length} clinica(s) removida(s)`)
  }

  for (const userId of manifest.userIds) {
    const { error } = await admin.auth.admin.deleteUser(userId)
    // Usuario ja removido nao e falha: a limpeza e idempotente.
    if (error && !/not found/i.test(error.message)) {
      problems.push(`usuario ${userId}: ${error.message}`)
    } else {
      console.log(`  usuario ${userId} removido`)
    }
  }

  if (problems.length > 0) {
    console.error(`\nLimpeza incompleta:\n  ${problems.join('\n  ')}`)
    console.error(`Manifesto preservado em ${manifestPath}`)
    process.exit(1)
  }

  rmSync(manifestPath, { force: true })
  console.log('Limpeza concluida.')
}

const args = process.argv.slice(2)

if (args.length > 1) {
  console.error('Informe exatamente UM test_run_id. Limpeza em lote nao existe por design.')
  process.exit(1)
}

const arg = args[0]

if (!arg) {
  listRuns()
  console.log('\nUso: pnpm test:isolation:cleanup <test_run_id>')
} else if (arg === '--list') {
  listRuns()
} else {
  await cleanup(arg)
}
