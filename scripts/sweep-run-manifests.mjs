#!/usr/bin/env node
/**
 * Varre `supabase/tests/.runs/` e apaga SOMENTE os manifestos cujos recursos
 * comprovadamente nao existem mais.
 *
 * POR QUE ISSO EXISTE
 *
 * Um manifesto e a unica lista de IDs de uma execucao que deixou sobra. Apagar
 * a pasta com `rm` e rapido e destroi exatamente o registro de recuperacao de
 * quem mais precisa dele — aconteceu neste projeto, e o resultado foram 39
 * contas e 26 clinicas de teste orfas no Dev sem nenhum arquivo apontando para
 * elas. A limpeza teve de ser reconstruida por identidade.
 *
 * Este script inverte o default: nada e apagado sem antes o banco confirmar
 * que nao ha o que recuperar.
 *
 * READ-ONLY no banco. Nao remove NENHUM recurso — so arquivos de manifesto de
 * execucoes ja limpas. Para remover recursos, use
 * `pnpm test:isolation:cleanup <test_run_id>`, que apaga por ID exato.
 *
 *   pnpm test:runs:sweep            lista e apaga os manifestos ja limpos
 *   pnpm test:runs:sweep --dry-run  so lista, nao apaga nada
 */
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadDotenv({ path: join(ROOT, '.env.test') })

const DIR = join(ROOT, 'supabase', 'tests', '.runs')
const dryRun = process.argv.includes('--dry-run')

const url = process.env.SUPABASE_URL
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceRole) {
  console.error('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao necessarios (.env.test).')
  process.exit(1)
}

/*
 * Producao NUNCA entra nesta lista. O script so LE do banco, mas o ambiente
 * declarado e a guarda que impede alguem de apontar a ferramenta para o lugar
 * errado e tirar conclusoes sobre o banco errado.
 */
const ambiente = process.env.SUPABASE_TEST_ENVIRONMENT
if (ambiente !== 'development' && ambiente !== 'staging') {
  console.error(`SUPABASE_TEST_ENVIRONMENT=${ambiente ?? '(vazio)'}: esperado development ou staging.`)
  process.exit(1)
}

const admin = createClient(url, serviceRole, { auth: { persistSession: false } })

let arquivos
try {
  arquivos = readdirSync(DIR).filter((f) => f.endsWith('.json'))
} catch {
  console.log('  Nao ha diretorio .runs/: nada a varrer.')
  process.exit(0)
}

if (arquivos.length === 0) {
  console.log('  .runs/ esta vazio: nada a varrer.')
  process.exit(0)
}

console.log(`\n  ${arquivos.length} manifesto(s) em .runs/${dryRun ? '  (dry-run)' : ''}\n`)

let apagados = 0
let preservados = 0

for (const arquivo of arquivos) {
  const caminho = join(DIR, arquivo)
  let manifesto
  try {
    manifesto = JSON.parse(readFileSync(caminho, 'utf8'))
  } catch (e) {
    // Manifesto ilegivel: nao da para verificar, entao nao da para apagar.
    console.log(`  PRESERVADO  ${arquivo}  (ilegivel: ${e.message})`)
    preservados += 1
    continue
  }

  const sobras = []

  const clinicIds = manifesto.clinicIds ?? []
  if (clinicIds.length > 0) {
    const { data, error } = await admin.from('clinics').select('id').in('id', clinicIds)
    if (error) sobras.push(`verificacao de clinicas falhou: ${error.message}`)
    else for (const linha of data ?? []) sobras.push(`clinica ${linha.id}`)
  }

  for (const userId of manifesto.userIds ?? []) {
    const { data, error } = await admin.auth.admin.getUserById(userId)
    if (data?.user) sobras.push(`usuario ${userId}`)
    else if (error && !/not found/i.test(error.message) && error.status !== 404) {
      sobras.push(`verificacao do usuario ${userId} falhou: ${error.message}`)
    }
  }

  if (sobras.length > 0) {
    console.log(`  PRESERVADO  ${arquivo}`)
    for (const s of sobras) console.log(`              ${s}`)
    console.log(`              limpe com: pnpm test:isolation:cleanup ${manifesto.testRunId}`)
    preservados += 1
    continue
  }

  if (!dryRun) rmSync(caminho, { force: true })
  console.log(`  ${dryRun ? 'APAGARIA  ' : 'apagado   '}  ${arquivo}  (nenhum recurso remanescente)`)
  apagados += 1
}

console.log(
  `\n  ${apagados} ${dryRun ? 'seriam apagados' : 'apagado(s)'}, ${preservados} preservado(s)\n`,
)
process.exit(preservados > 0 ? 1 : 0)
