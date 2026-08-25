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

async function cleanup(testRunId) {
  const manifestPath = join(MANIFEST_DIR, `${testRunId}.json`)
  if (!existsSync(manifestPath)) {
    console.error(`Manifesto nao encontrado: ${manifestPath}`)
    console.error('Rode com --list para ver as execucoes pendentes.')
    process.exit(1)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const url = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const environment = process.env.SUPABASE_TEST_ENVIRONMENT

  if (!url || !serviceRoleKey) {
    console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorias no .env.test.')
    process.exit(1)
  }

  if (environment !== 'development' && environment !== 'staging') {
    console.error(
      `SUPABASE_TEST_ENVIRONMENT deve ser development ou staging (recebido: ${environment ?? 'nao definido'}).`,
    )
    process.exit(1)
  }

  // O manifesto guarda contra qual projeto os recursos foram criados. Limpar
  // IDs de um projeto usando as credenciais de outro seria apagar as linhas
  // erradas caso os UUIDs coincidissem.
  if (manifest.supabaseUrl !== url) {
    console.error(
      `Manifesto pertence a ${manifest.supabaseUrl}, mas o .env.test aponta para ${url}.`,
    )
    process.exit(1)
  }

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

const arg = process.argv[2]

if (!arg || arg === '--list') {
  listRuns()
  if (!arg) {
    console.log('\nUso: pnpm test:isolation:cleanup <test_run_id>')
  }
} else {
  await cleanup(arg)
}
