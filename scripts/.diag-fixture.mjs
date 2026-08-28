/**
 * Cria uma clinica sintetica minima para o diagnostico e grava o manifesto.
 * Nenhum dado real de paciente.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
config({ path: 'D:/Projeto Piloto Clinicas/.env.test' })

const DIR = 'D:/Projeto Piloto Clinicas/.diag'
mkdirSync(DIR, { recursive: true })

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const runId = randomUUID()
const email = `diag-${runId.slice(0, 8)}@example.test`
const senha = `Senha-Diag-${runId.slice(0, 8)}!`

const { data: u, error } = await admin.auth.admin.createUser({
  email,
  password: senha,
  email_confirm: true,
  user_metadata: { full_name: 'Diagnostico', test_run_id: runId },
})
if (error) throw new Error(error.message)

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})
await db.auth.signInWithPassword({ email, password: senha })
const { data: clinica } = await db
  .rpc('create_clinic_with_owner', { p_name: `Diagnostico ${runId.slice(0, 8)}` })
  .single()

await db
  .from('patients')
  .insert({ clinic_id: clinica.id, name: 'Paciente Sintetico', phone: '11900000000' })

const manifesto = { runId, email, senha, users: [u.user.id], clinics: [clinica.id] }
writeFileSync(`${DIR}/manifesto.json`, JSON.stringify(manifesto, null, 2))
console.log(`  fixture criada: clinica ${clinica.id}`)
