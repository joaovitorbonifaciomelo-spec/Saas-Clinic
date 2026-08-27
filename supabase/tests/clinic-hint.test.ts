import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient, loadIsolationEnv, type IsolationEnv } from './helpers'

/**
 * Seguranca do cookie `active_clinic_id`.
 *
 * O cookie e PALPITE, nunca prova de autorizacao: ele existe apenas para as
 * buscas de dados comecarem em paralelo com /api/me em vez de depois dele.
 *
 * A pergunta que esta bateria responde e uma so, feita de varios angulos: um
 * cookie adulterado consegue trazer alguma coisa que o usuario nao poderia ver?
 * A resposta precisa ser nao mesmo quando o UUID e valido, mesmo quando aponta
 * para uma clinica que existe de verdade e mesmo quando o usuario e membro de
 * alguma clinica.
 *
 * Roda contra o app Next em WEB_URL. Sem ele no ar, a suite falha alto em vez
 * de passar em silencio — teste de seguranca que se auto-desliga e pior que
 * teste nenhum.
 */
const WEB = process.env.WEB_URL ?? 'http://localhost:3100'
const COOKIE = 'active_clinic_id'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Ator {
  email: string
  password: string
  userId: string
  clinicId: string
  clinicName: string
  patientName: string
}

const env: IsolationEnv = loadIsolationEnv()
const admin = createAdminClient(env)
const runId = randomUUID()
const criados = { users: [] as string[], clinics: [] as string[] }

let browser: Browser
let webOnline = false
let A: Ator
let B: Ator

async function criarAtor(rotulo: string): Promise<Ator> {
  const email = `hint-${rotulo}-${runId}@example.test`
  const password = `Senha-${runId}!`
  const clinicName = `Clinica ${rotulo} ${runId.slice(0, 8)}`
  const patientName = `Paciente ${rotulo} ${runId.slice(0, 8)}`

  const { data: u, error: ue } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Usuario ${rotulo}` },
  })
  if (ue) throw new Error(ue.message)
  criados.users.push(u.user.id)

  const db: SupabaseClient = createClient(env.url, env.anonKey, {
    auth: { persistSession: false },
  })
  const { data: sess } = await db.auth.signInWithPassword({ email, password })
  const token = sess?.session?.access_token
  if (!token) throw new Error('sem sessao para ' + rotulo)

  const { data: clinic, error: ce } = await db
    .rpc('create_clinic_with_owner', { p_name: clinicName })
    .single<{ id: string }>()
  if (ce) throw new Error(ce.message)
  criados.clinics.push(clinic!.id)

  const r = await fetch(`${env.apiUrl}/api/patients`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-clinic-id': clinic!.id,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: patientName, phone: '11987650000' }),
  })
  if (r.status !== 201) throw new Error(`paciente de ${rotulo}: HTTP ${r.status}`)

  return {
    email,
    password,
    userId: u.user.id,
    clinicId: clinic!.id,
    clinicName,
    patientName,
  }
}

/** Contexto novo, ja logado como o ator. */
async function logar(ator: Ator): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: WEB })
  const page = await ctx.newPage()
  await page.goto('/login', { waitUntil: 'networkidle' })
  await page.fill('input[name="email"]', ator.email)
  await page.fill('input[name="password"]', ator.password)
  await Promise.all([
    page.waitForURL(/dashboard|onboarding/, { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ])
  await page.close()
  return ctx
}

async function lerCookie(ctx: BrowserContext): Promise<string | undefined> {
  const cookies = await ctx.cookies()
  return cookies.find((c) => c.name === COOKIE)?.value
}

async function escreverCookie(ctx: BrowserContext, valor: string): Promise<void> {
  const url = new URL(WEB)
  await ctx.addCookies([
    { name: COOKIE, value: valor, domain: url.hostname, path: '/', httpOnly: true },
  ])
}

/** Abre /patients e devolve o texto visivel da coluna mestre. */
async function textoDePacientes(ctx: BrowserContext): Promise<string> {
  const page = await ctx.newPage()
  await page.goto('/patients', { waitUntil: 'networkidle' })
  await page.waitForSelector('.master-list', { timeout: 30_000 })
  const texto = (await page.locator('.content').innerText()).replace(/\s+/g, ' ')
  await page.close()
  return texto
}

beforeAll(async () => {
  try {
    const health = await fetch(`${env.apiUrl}/api/health`)
    if (!health.ok) throw new Error('API fora do ar')
    const web = await fetch(`${WEB}/login`)
    webOnline = web.ok
  } catch {
    webOnline = false
  }
  if (!webOnline) {
    throw new Error(
      `App Next precisa estar no ar em ${WEB} para os testes do cookie de clinica. ` +
        'Suba com `next start` e reexecute (WEB_URL configura o endereco).',
    )
  }

  browser = await chromium.launch()
  A = await criarAtor('A')
  B = await criarAtor('B')
}, 180_000)

afterAll(async () => {
  await browser?.close()
  if (criados.clinics.length > 0) {
    await admin.from('clinics').delete().in('id', criados.clinics)
  }
  for (const id of criados.users) await admin.auth.admin.deleteUser(id)
}, 120_000)

describe('cookie active_clinic_id — escrita', () => {
  it('login popula o cookie com a clinica ativa, em formato UUID', async () => {
    const ctx = await logar(A)
    const valor = await lerCookie(ctx)
    expect(valor).toBeDefined()
    expect(valor).toMatch(UUID_RE)
    expect(valor).toBe(A.clinicId)
    await ctx.close()
  })

  it('logout remove o cookie', async () => {
    const ctx = await logar(A)
    expect(await lerCookie(ctx)).toBe(A.clinicId)

    const page = await ctx.newPage()
    await page.goto('/dashboard', { waitUntil: 'networkidle' })
    await Promise.all([
      page.waitForURL(/\/login/, { timeout: 60_000 }),
      page.click('form[action] button[type="submit"], .topbar form button'),
    ])
    expect(await lerCookie(ctx)).toBeUndefined()
    await ctx.close()
  })

  it('onboarding cria a clinica e passa a popular o cookie', async () => {
    const email = `hint-onb-${runId}@example.test`
    const password = `Senha-${runId}!`
    const { data: u, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Usuario Onboarding' },
    })
    if (error) throw new Error(error.message)
    criados.users.push(u.user.id)

    const ctx = await browser.newContext({ baseURL: WEB })
    const page = await ctx.newPage()
    await page.goto('/login', { waitUntil: 'networkidle' })
    await page.fill('input[name="email"]', email)
    await page.fill('input[name="password"]', password)
    await Promise.all([
      page.waitForURL(/dashboard|onboarding/, { timeout: 60_000 }),
      page.click('button[type="submit"]'),
    ])

    // Sem clinica ainda: o cookie nao pode existir.
    await page.goto('/dashboard', { waitUntil: 'networkidle' })
    expect(page.url()).toContain('/onboarding')
    expect(await lerCookie(ctx)).toBeUndefined()

    const nome = `Clinica Onboarding ${runId.slice(0, 8)}`
    await page.fill('input[name="name"]', nome)
    await Promise.all([
      page.waitForURL(/\/dashboard/, { timeout: 60_000 }),
      page.click('button[type="submit"]'),
    ])

    const valor = await lerCookie(ctx)
    expect(valor).toMatch(UUID_RE)

    const { data: clinicas } = await admin.from('clinics').select('id').eq('created_by', u.user.id)
    for (const c of clinicas ?? []) criados.clinics.push(c.id)
    expect((clinicas ?? []).map((c) => c.id)).toContain(valor)

    await ctx.close()
  })
})

describe('cookie active_clinic_id — o palpite nunca vira permissao', () => {
  it('cookie correto: a tela mostra os dados da propria clinica', async () => {
    const ctx = await logar(A)
    const texto = await textoDePacientes(ctx)
    expect(texto).toContain(A.patientName)
    expect(texto).not.toContain(B.patientName)
    await ctx.close()
  })

  it('sem cookie: cai no fallback e continua funcionando', async () => {
    const ctx = await logar(A)
    await ctx.clearCookies({ name: COOKIE })
    expect(await lerCookie(ctx)).toBeUndefined()

    const texto = await textoDePacientes(ctx)
    expect(texto).toContain(A.patientName)
    expect(texto).not.toContain(B.patientName)
    await ctx.close()
  })

  it('cookie malformado nao quebra a tela', async () => {
    for (const lixo of ['nao-e-uuid', '../../etc/passwd', '', "' OR 1=1 --", '12345']) {
      const ctx = await logar(A)
      await escreverCookie(ctx, lixo)
      const texto = await textoDePacientes(ctx)
      expect(texto, `cookie ${JSON.stringify(lixo)}`).toContain(A.patientName)
      expect(texto).not.toContain(B.patientName)
      await ctx.close()
    }
  }, 120_000)

  it('cookie apontando para a clinica de OUTRO usuario nao vaza nada', async () => {
    const ctx = await logar(A)
    await escreverCookie(ctx, B.clinicId)

    const texto = await textoDePacientes(ctx)
    // A trava definitiva: nada de B aparece, e A continua vendo o que e seu.
    expect(texto).not.toContain(B.patientName)
    expect(texto).not.toContain(B.clinicName)
    expect(texto).toContain(A.patientName)
    await ctx.close()
  })

  it('cookie de clinica inexistente nao revela existencia nem quebra', async () => {
    const ctx = await logar(A)
    await escreverCookie(ctx, randomUUID())

    const texto = await textoDePacientes(ctx)
    expect(texto).toContain(A.patientName)
    expect(texto).not.toContain(B.patientName)
    await ctx.close()
  })

  it('o cabecalho da clinica ativa continua sendo o validado, nao o do cookie', async () => {
    const ctx = await logar(A)
    await escreverCookie(ctx, B.clinicId)

    const page = await ctx.newPage()
    await page.goto('/dashboard', { waitUntil: 'networkidle' })
    const shell = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    expect(shell).toContain(A.clinicName)
    expect(shell).not.toContain(B.clinicName)
    await page.close()
    await ctx.close()
  })

  it('sessao expirada continua indo para /login, com ou sem cookie', async () => {
    const ctx = await logar(A)
    await escreverCookie(ctx, A.clinicId)

    // Derruba so os cookies de auth do Supabase; o palpite permanece.
    const auth = (await ctx.cookies()).filter((c) => c.name.startsWith('sb-'))
    for (const c of auth) await ctx.clearCookies({ name: c.name })

    const page = await ctx.newPage()
    await page.goto('/patients', { waitUntil: 'networkidle' })
    expect(page.url()).toContain('/login')
    await page.close()
    await ctx.close()
  })
})
