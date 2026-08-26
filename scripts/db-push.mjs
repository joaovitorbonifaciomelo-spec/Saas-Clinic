#!/usr/bin/env node
/**
 * Portao de confirmacao para `supabase db push`.
 *
 *   pnpm db:preflight                    # so mostra o alvo, nunca aplica
 *   pnpm db:push                         # mostra o alvo e pede confirmacao
 *   pnpm db:push --confirm <project-ref> # nao-interativo; o ref precisa bater
 *
 * Existe para tornar impossivel aplicar migration no projeto errado por engano:
 * o alvo e sempre impresso antes, e o push so acontece com confirmacao explicita.
 *
 * Este script NUNCA imprime chave, senha ou connection string. Apenas
 * identificadores publicos: project ref, host e nomes de arquivo.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { spawnSync } from 'node:child_process'
import { config as loadDotenv } from 'dotenv'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const PROJECT_REF_FILE = join(ROOT, 'supabase', '.temp', 'project-ref')

loadDotenv({ path: join(ROOT, '.env.test') })

/** Placeholders do .env.example: se sobraram, o arquivo nao foi preenchido. */
const PLACEHOLDER_MARKERS = ['SEU-PROJETO', 'cole-a-', 'SEU_PROJECT_REF', 'SENHA@']
/**
 * Senha colada do painel mantendo os colchetes do exemplo
 * (postgresql://postgres:[YOUR-PASSWORD]@...). Falha com 28P01, que parece
 * senha errada e na verdade e colchete sobrando. Barrado aqui.
 */
const BRACKETED_PASSWORD = /^SUPABASE_DB_URL=postgresql:\/\/[^:]+:\[.*\]@/m

function fail(message, ...details) {
  console.error(`\n  ABORTADO: ${message}`)
  for (const detail of details) console.error(`  ${detail}`)
  console.error('')
  process.exit(1)
}

/** Extrai o project ref do host, sem expor a URL inteira nem qualquer chave. */
function refFromUrl(url) {
  try {
    const host = new URL(url).host
    const match = /^([a-z0-9]{16,})\.supabase\./i.exec(host)
    return { host, ref: match ? match[1] : null }
  } catch {
    return { host: null, ref: null }
  }
}

function readLinkedRef() {
  if (!existsSync(PROJECT_REF_FILE)) return null
  const value = readFileSync(PROJECT_REF_FILE, 'utf8').trim()
  return value.length > 0 ? value : null
}

function listMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return []
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
}

function describeTarget() {
  const linkedRef = readLinkedRef()
  const environment = process.env.SUPABASE_TEST_ENVIRONMENT
  const envUrl = process.env.SUPABASE_URL
  const { host: envHost, ref: envRef } = envUrl ? refFromUrl(envUrl) : { host: null, ref: null }
  const migrations = listMigrations()

  console.log('\n  ALVO DO DB PUSH')
  console.log('  ' + '-'.repeat(60))
  console.log(`  Projeto linkado (supabase link) : ${linkedRef ?? 'NENHUM'}`)
  console.log(`  Host do .env.test               : ${envHost ?? 'nao definido'}`)
  console.log(`  Project ref do .env.test        : ${envRef ?? 'nao identificado'}`)
  console.log(`  Ambiente declarado              : ${environment ?? 'NAO DEFINIDO'}`)
  console.log(`  Migrations a aplicar            : ${migrations.length}`)
  for (const migration of migrations) console.log(`      ${migration}`)
  console.log('  ' + '-'.repeat(60))

  return { linkedRef, environment, envRef, envHost, migrations }
}

function validateTarget(target) {
  const { linkedRef, environment, envRef, migrations } = target

  if (!linkedRef) {
    fail(
      'nenhum projeto Supabase esta linkado.',
      'Rode: pnpm supabase login && pnpm supabase link --project-ref <ref>',
    )
  }

  if (migrations.length === 0) {
    fail('nenhuma migration encontrada em supabase/migrations/.')
  }

  if (environment !== 'development' && environment !== 'staging') {
    fail(
      `SUPABASE_TEST_ENVIRONMENT e "${environment ?? 'nao definido'}".`,
      'Este portao so aplica migrations em development ou staging.',
      'Para producao, use um processo de deploy revisado — nao este script.',
    )
  }

  // Divergencia entre o projeto linkado e o que o .env.test aponta e o sintoma
  // classico de "linkei um, configurei outro". O push iria para o linkado.
  if (envRef && envRef !== linkedRef) {
    fail(
      'o projeto linkado nao e o mesmo do .env.test.',
      `linkado   : ${linkedRef}`,
      `.env.test : ${envRef}`,
      'O push iria para o LINKADO. Corrija antes de continuar.',
    )
  }

  // Nao imprimimos o valor: so avisamos que o arquivo ainda tem placeholder.
  const envTestPath = join(ROOT, '.env.test')
  if (existsSync(envTestPath)) {
    const raw = readFileSync(envTestPath, 'utf8')
    const untouched = PLACEHOLDER_MARKERS.filter((marker) => raw.includes(marker))
    if (BRACKETED_PASSWORD.test(raw)) {
      fail(
        'a senha em SUPABASE_DB_URL esta entre colchetes.',
        'Os colchetes vem do exemplo do painel e nao fazem parte da senha. Remova-os.',
      )
    }
    if (untouched.length > 0) {
      fail(
        '.env.test ainda contem valores de exemplo nao preenchidos.',
        'Substitua os placeholders pelas credenciais reais do projeto.',
      )
    }
  }
}

async function confirm(target) {
  const confirmIndex = process.argv.indexOf('--confirm')
  const providedRef = confirmIndex >= 0 ? process.argv[confirmIndex + 1] : null

  if (providedRef) {
    if (providedRef !== target.linkedRef) {
      fail(
        'o ref confirmado nao corresponde ao projeto linkado.',
        `confirmado : ${providedRef}`,
        `linkado    : ${target.linkedRef}`,
      )
    }
    console.log(`\n  Confirmado por argumento: ${providedRef}`)
    return
  }

  if (!process.stdin.isTTY) {
    fail(
      'confirmacao necessaria.',
      'Em execucao nao-interativa, confirme o destino explicitamente:',
      `    pnpm db:push --confirm ${target.linkedRef}`,
    )
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(
    `\n  Aplicar ${target.migrations.length} migration(s) em "${target.linkedRef}" (${target.environment})?\n  Digite o project ref para confirmar: `,
  )
  rl.close()

  if (answer.trim() !== target.linkedRef) {
    fail('confirmacao nao corresponde ao project ref. Nada foi aplicado.')
  }
}

const target = describeTarget()

if (process.argv.includes('--check')) {
  console.log('\n  Modo verificacao: nada sera aplicado.\n')
  validateTarget(target)
  console.log('  Alvo valido. Para aplicar: pnpm db:push\n')
  process.exit(0)
}

validateTarget(target)
await confirm(target)

console.log('\n  Executando: supabase db push\n')
const result = spawnSync('pnpm', ['supabase', 'db', 'push'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
process.exit(result.status ?? 1)
