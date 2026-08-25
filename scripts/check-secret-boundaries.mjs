#!/usr/bin/env node
/**
 * Verifica a fronteira de segredos do repositorio.
 *
 * Regras conferidas:
 *  1. SUPABASE_SERVICE_ROLE_KEY e SUPABASE_DB_URL nao sao referenciados em
 *     apps/web nem em apps/api. Se aparecerem la, o isolamento por RLS deixa de
 *     ser garantia: qualquer query passaria por cima dele.
 *  2. Nenhuma variavel de segredo usa o prefixo NEXT_PUBLIC_ (que embute o valor
 *     no bundle do navegador).
 *  3. Os arquivos .env.example contem apenas placeholders, nunca chave real.
 *  4. Nenhum arquivo .env real esta rastreado pelo git.
 *
 * Falha com exit code 1 se alguma regra for violada.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const ADMIN_ONLY_VARS = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL']
const APP_DIRS = ['apps/web', 'apps/api']
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git'])
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|env|example|md|yaml|yml)$/

/** Formato de JWT do Supabase (anon/service_role) e das novas chaves sb_*. */
const REAL_KEY_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/,
  /postgresql:\/\/postgres[^\s:]*:(?!SENHA)[^\s@]{6,}@/,
]

const failures = []

function walk(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (TEXT_EXT.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Remove comentarios antes de procurar por uso de variavel.
 *
 * Sem isso o proprio comentario que EXPLICA por que a service_role nao esta ali
 * seria acusado de usa-la. O que interessa e codigo executavel e valor de
 * configuracao, nao prosa.
 */
function stripComments(content, file) {
  if (/\.(md|markdown)$/.test(file)) return ''
  if (/\.(env|example)$/.test(file)) {
    return content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
  }
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// -- Regra 1: credencial administrativa fora das aplicacoes -------------------
for (const appDir of APP_DIRS) {
  for (const file of walk(join(ROOT, appDir))) {
    const content = stripComments(readFileSync(file, 'utf8'), file)
    for (const variable of ADMIN_ONLY_VARS) {
      if (content.includes(variable)) {
        failures.push(
          `${relative(ROOT, file).split(sep).join('/')}: referencia ${variable}, ` +
            'que deve existir apenas no escopo administrativo/testes.',
        )
      }
    }
  }
}

// -- Regra 2: segredo exposto ao navegador -----------------------------------
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join('/')
  if (rel.startsWith('scripts/')) continue
  const content = stripComments(readFileSync(file, 'utf8'), file)
  const matches = content.match(
    /NEXT_PUBLIC_[A-Z0-9_]*(SERVICE_ROLE|SECRET|DB_URL|PASSWORD)[A-Z0-9_]*/g,
  )
  if (matches) {
    failures.push(`${rel}: ${[...new Set(matches)].join(', ')} expoe segredo no bundle do browser.`)
  }
}

// -- Regra 3: .env.example so com placeholder --------------------------------
for (const file of walk(ROOT).filter((f) => f.endsWith('.example'))) {
  const rel = relative(ROOT, file).split(sep).join('/')
  const content = readFileSync(file, 'utf8')
  for (const pattern of REAL_KEY_PATTERNS) {
    if (pattern.test(content)) {
      failures.push(`${rel}: parece conter uma credencial real, nao um placeholder.`)
    }
  }
}

// -- Regra 4: nenhum .env rastreado pelo git ---------------------------------
try {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /(^|\/)\.env($|\.)/.test(line) && !line.endsWith('.example'))
  for (const file of tracked) {
    failures.push(`${file}: arquivo de ambiente rastreado pelo git.`)
  }
} catch {
  // Fora de um repositorio git: nada a verificar aqui.
}

if (failures.length > 0) {
  console.error('Fronteira de segredos VIOLADA:\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('')
  process.exit(1)
}

console.log('Fronteira de segredos OK:')
console.log('  - service_role e DB_URL ausentes de apps/web e apps/api')
console.log('  - nenhum segredo sob prefixo NEXT_PUBLIC_')
console.log('  - .env.example contem apenas placeholders')
console.log('  - nenhum .env rastreado pelo git')
