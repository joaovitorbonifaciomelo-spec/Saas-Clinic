/**
 * Remove EXATAMENTE o que a captura criou, lendo o manifesto.
 *
 * Sem LIKE, sem prefixo de nome, sem truncate. Se o manifesto nao existir, nao
 * ha nada a fazer — e melhor nao apagar nada do que adivinhar o que apagar.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync, rmSync } from 'node:fs'
config({ path: 'D:/Projeto Piloto Clinicas/.env.test' })

const DIR = process.env.SHOT_DIR ?? 'D:/Projeto Piloto Clinicas/.shots'
const caminho = `${DIR}/manifesto.json`

if (!existsSync(caminho)) {
  console.log('  Nenhum manifesto encontrado. Nada foi removido.')
  process.exit(0)
}

const m = JSON.parse(readFileSync(caminho, 'utf8'))
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

console.log(`\n  Removendo run ${m.runId}`)
console.log(`    clinicas: ${m.clinics.length}   usuarios: ${m.users.length}`)

// Clinicas primeiro: created_by e ON DELETE SET NULL, entao apagar o usuario
// antes deixaria a clinica orfa com todos os pacientes e conversas.
if (m.clinics.length > 0) {
  const { error } = await admin.from('clinics').delete().in('id', m.clinics)
  if (error) {
    console.error(`  FALHA ao remover clinicas: ${error.message}`)
    process.exit(1)
  }
}
for (const id of m.users) {
  const { error } = await admin.auth.admin.deleteUser(id)
  if (error) console.error(`  aviso: usuario ${id}: ${error.message}`)
}

// Confere que sumiu mesmo, em vez de confiar no retorno.
const { data: sobrou } = await admin.from('clinics').select('id').in('id', m.clinics)
if ((sobrou ?? []).length > 0) {
  console.error(`  FALHA: ${sobrou.length} clinica(s) ainda existem. Manifesto mantido.`)
  process.exit(1)
}

rmSync(caminho)
console.log('  Removido. Manifesto apagado.\n')
