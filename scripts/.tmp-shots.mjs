/**
 * Capturas do Atendimento para revisao visual.
 *
 * Cria fixtures SINTETICAS proprias, registra cada id, captura e apaga
 * exatamente o que criou — sem LIKE, sem prefixo, sem truncate.
 */
import { config } from 'dotenv'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
config({ path: 'D:/Projeto Piloto Clinicas/.env.test' })

const WEB = process.env.SHOT_WEB_URL ?? 'https://saas-clinic-web.vercel.app'
const DIR = process.env.SHOT_DIR ?? 'D:/Projeto Piloto Clinicas/.shots'
mkdirSync(DIR, { recursive: true })

const url = process.env.SUPABASE_URL
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const runId = randomUUID()
const manifesto = { runId, users: [], clinics: [] }
const senha = `Senha-Shot-${runId.slice(0, 8)}!`

async function usuario(rotulo, nome) {
  const email = `shot-${rotulo}-${runId.slice(0, 8)}@example.test`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { full_name: nome, test_run_id: runId, purpose: 'captura de tela' },
  })
  if (error) throw new Error(`${rotulo}: ${error.message}`)
  manifesto.users.push(data.user.id)
  return { id: data.user.id, email, nome }
}

const maria = await usuario('maria', 'Maria Souza')
const joao = await usuario('joao', 'João Lima')
const ana = await usuario('ana', 'Ana Prado')

const db = createClient(url, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
await db.auth.signInWithPassword({ email: maria.email, password: senha })
const { data: clinica } = await db
  .rpc('create_clinic_with_owner', { p_name: 'Clínica Vida (demonstração)' })
  .single()
manifesto.clinics.push(clinica.id)
writeFileSync(`${DIR}/manifesto.json`, JSON.stringify(manifesto, null, 2))

for (const u of [joao, ana]) {
  await admin
    .from('clinic_members')
    .insert({ clinic_id: clinica.id, user_id: u.id, role: 'attendant' })
}

const { data: joana } = await db
  .from('patients')
  .insert({
    clinic_id: clinica.id,
    name: 'Joana Ribeiro',
    phone: '11988887777',
    insurance_provider: 'Unimed',
  })
  .select('id')
  .single()
await db
  .from('patients')
  .insert({ clinic_id: clinica.id, name: 'Carlos Prado', phone: '11955554444' })

const min = (n) => new Date(Date.now() - n * 60_000).toISOString()

async function conversa(nome, telefone, patientId, mensagens, minutos) {
  const { data } = await db.rpc('conversation_create_manual', {
    p_clinic_id: clinica.id,
    p_contact_phone_e164: telefone,
    p_contact_name_snapshot: nome,
    p_patient_id: patientId,
  })
  const c = data.conversation
  for (const [dir, texto, quando] of mensagens) {
    await db.rpc('conversation_add_manual_message', {
      p_conversation_id: c.id,
      p_direction: dir,
      p_body: texto,
      p_occurred_at: min(quando),
    })
  }
  return c
}

// Cenario: uma fila plausivel de recepcao, sem dado real de ninguem.
const comPaciente = await conversa(
  'Joana Ribeiro',
  '+5511988887777',
  joana.id,
  [
    ['inbound', 'Bom dia! Consigo remarcar minha consulta de quinta?', 90],
    ['outbound', 'Bom dia, Joana! Consigo sim. Prefere de manhã ou à tarde?', 88],
    ['inbound', 'De manhã, se possível.', 85],
  ],
  90,
)

const semPaciente = await conversa(
  'Pedro Alves',
  '+5511977776666',
  null,
  [
    ['inbound', 'Boa tarde, vocês atendem por convênio?', 40],
    ['outbound', 'Boa tarde! Atendemos, sim. Qual é o seu convênio?', 38],
  ],
  40,
)

const aguardando = await conversa(
  'Marina Souza',
  '+5511966665555',
  null,
  [['outbound', 'Marina, enviei a guia por e-mail. Me avise quando receber.', 25]],
  25,
)

const encerrada = await conversa(
  'Caso resolvido',
  '+5511933332222',
  null,
  [
    ['inbound', 'Consegui remarcar pelo telefone, obrigada!', 15],
    ['outbound', 'Que ótimo. Qualquer coisa é só chamar.', 14],
  ],
  15,
)

await conversa('Rita Camargo', '+5511922221111', null, [], 5)

// Estados: uma atribuida, uma aguardando, uma encerrada.
const assumida = await db.rpc('conversation_assign', {
  p_conversation_id: comPaciente.id,
  p_expected_version: comPaciente.version,
})
await db.rpc('conversation_set_status', {
  p_conversation_id: aguardando.id,
  p_expected_version: aguardando.version,
  p_status: 'waiting_patient',
})
await db.rpc('conversation_set_status', {
  p_conversation_id: encerrada.id,
  p_expected_version: encerrada.version,
  p_status: 'resolved',
})

console.log(`\n  Fixtures criadas. Capturando contra ${WEB}\n`)

const browser = await chromium.launch()
const ctx = await browser.newContext({
  baseURL: WEB,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
})
ctx.setDefaultTimeout(120_000)
ctx.setDefaultNavigationTimeout(120_000)

const login = await ctx.newPage()
await login.goto('/login', { waitUntil: 'domcontentloaded' })
await login.fill('input[name="email"]', maria.email)
await login.fill('input[name="password"]', senha)
await Promise.all([
  login.waitForURL(/dashboard|onboarding/, { timeout: 120_000 }),
  login.click('button[type="submit"]'),
])
await login.close()

const page = await ctx.newPage()

async function capturar(nome, rota, preparar) {
  await page.goto(rota, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.at-shell', { timeout: 120_000 })
  if (preparar) await preparar()
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${DIR}/${nome}.png` })
  console.log(`  ok  ${nome}`)
}

await capturar('01-fila-conversa', `/atendimento?c=${comPaciente.id}`)
await capturar('02-sem-paciente', `/atendimento?c=${semPaciente.id}`)
await capturar('03-com-paciente', `/atendimento?c=${comPaciente.id}`)
await capturar('04-transferir', `/atendimento?c=${comPaciente.id}`, async () => {
  await page.click('button:has-text("Transferir")')
  await page.waitForSelector('.at-equipe')
})
await capturar('05-aguardando-paciente', `/atendimento?c=${aguardando.id}`)
await capturar('06-encerrado', `/atendimento?c=${encerrada.id}`)
await page.close()

// --- mobile ---------------------------------------------------------------
const mob = await browser.newContext({
  baseURL: WEB,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  storageState: await ctx.storageState(),
})
mob.setDefaultTimeout(120_000)
mob.setDefaultNavigationTimeout(120_000)
const mp = await mob.newPage()

await mp.goto('/atendimento', { waitUntil: 'domcontentloaded' })
await mp.waitForSelector('.at-item', { timeout: 120_000 })
await mp.waitForTimeout(700)
await mp.screenshot({ path: `${DIR}/07-mobile-fila.png` })
console.log('  ok  07-mobile-fila')

await mp.click('.at-item:has-text("Joana Ribeiro")')
await mp.waitForSelector('.at-thread-nome', { timeout: 120_000 })
await mp.waitForTimeout(700)
await mp.screenshot({ path: `${DIR}/08-mobile-conversa.png` })
console.log('  ok  08-mobile-conversa')

await mob.close()
await ctx.close()
await browser.close()

console.log(`\n  Capturas em ${DIR}`)
console.log(`  Manifesto: ${DIR}/manifesto.json`)
console.log(`  Para remover: node scripts/.tmp-shots-limpar.mjs\n`)
console.log(String(assumida.error ?? ''))
