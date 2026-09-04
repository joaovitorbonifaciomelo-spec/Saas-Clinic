/**
 * =============================================================================
 * DASHBOARD (Hoje) — INTEGRACAO COM PENDENCIAS, NO NAVEGADOR
 * =============================================================================
 *
 * Mesma disciplina de `pendencias-ui.test.ts`: navegador real, API real,
 * banco de desenvolvimento real. Clinica nasce sem nenhum agendamento, entao
 * "Precisa da sua atencao" so mostra o que este arquivo semeia — nenhuma
 * fixture de agendamento precisa existir para testar a parte de Pendencias.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dayBoundsInTimezone } from '@clinicas/shared'
import {
  createAdminClient,
  createAnonClient,
  loadIsolationEnv,
  TestResourceRegistry,
  type IsolationEnv,
} from './helpers'

const WEB = process.env.WEB_URL ?? 'http://localhost:3100'

let env: IsolationEnv
let admin: SupabaseClient
let registry: TestResourceRegistry
let browser: Browser
let ctx: BrowserContext
let db: SupabaseClient
let clinicId: string
let fuso: string

async function criarUsuario(rotulo: string, nome: string) {
  const email = `dash-pd-${rotulo}-${registry.testRunId}@example.test`
  const password = `Senha-Teste-${registry.testRunId}!`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: nome, test_run_id: registry.testRunId },
  })
  if (error || !data.user) throw new Error(`${rotulo}: ${error?.message}`)
  registry.registerUser(data.user.id)
  return { userId: data.user.id, email, password }
}

async function abrirDashboard(): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto('/dashboard', { waitUntil: 'networkidle' })
  await page.waitForSelector('.today-grid', { timeout: 30_000 })
  return page
}

async function criarTask(title: string, dueAt: string | null): Promise<string> {
  const { data, error } = await db.rpc('task_create', {
    p_clinic_id: clinicId,
    p_title: title,
    p_description: null,
    p_due_at: dueAt,
    p_assignee_id: null,
    p_patient_id: null,
    p_conversation_id: null,
    p_appointment_id: null,
  })
  if (error) throw new Error(error.message)
  return (data as { task: { id: string } }).task.id
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)

  const [api, web] = await Promise.all([
    fetch(`${env.apiUrl}/api/health`).catch(() => null),
    fetch(`${WEB}/login`).catch(() => null),
  ])
  if (api?.ok !== true) throw new Error(`API precisa estar no ar em ${env.apiUrl}.`)
  if (web?.ok !== true) throw new Error(`App Next precisa estar no ar em ${WEB}.`)

  browser = await chromium.launch()

  const u = await criarUsuario('marina', 'Marina Costa')
  db = createAnonClient(env)
  await db.auth.signInWithPassword({ email: u.email, password: u.password })

  const { data: clinica } = await db
    .rpc('create_clinic_with_owner', { p_name: `Clinica DashPend ${registry.testRunId.slice(0, 8)}` })
    .single<{ id: string }>()
  clinicId = clinica!.id
  registry.registerClinic(clinicId)

  const { data: clinicRow } = await admin.from('clinics').select('timezone').eq('id', clinicId).single()
  fuso = (clinicRow as { timezone: string }).timezone

  ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto('/login', { waitUntil: 'networkidle' })
  await page.fill('input[name="email"]', u.email)
  await page.fill('input[name="password"]', u.password)
  await Promise.all([
    page.waitForURL(/dashboard|onboarding/, { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ])
  await page.close()
}, 300_000)

afterAll(async () => {
  await ctx?.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (registry) await registry.cleanup(admin)
}, 180_000)

describe('"Precisa da sua atenção" sem nenhuma pendência', () => {
  it('mostra "Tudo em dia" — nenhum agendamento e nenhuma pendência aberta', async () => {
    const page = await abrirDashboard()
    const cartao = page.locator('.card', { has: page.locator('h2', { hasText: 'Precisa da sua atenção' }) })
    expect(await cartao.locator('.attn-ok-title').innerText()).toBe('Tudo em dia')
    expect(await cartao.locator('.attn-row').count()).toBe(0)
    await page.close()
  })
})

describe('"Precisa da sua atenção" com pendências', () => {
  it('Atrasadas antes de Hoje, no máximo 3, atrasada destacada, "Ver todas" quando há mais', async () => {
    const { startOfToday } = dayBoundsInTimezone(fuso, new Date())
    // Prazos DISTINTOS em cada grupo: a API desempata por id (uuid, sem
    // relacao com ordem de criacao) quando due_at repete, entao usar o mesmo
    // instante pros tres "de hoje" tornaria a ordem imprevisivel.
    const ontem1 = new Date(startOfToday.getTime() - 4_600_000).toISOString()
    const ontem2 = new Date(startOfToday.getTime() - 3_600_000).toISOString()
    const hoje1 = new Date().toISOString()
    const hoje2 = new Date(Date.now() + 60_000).toISOString()
    const hoje3 = new Date(Date.now() + 120_000).toISOString()

    // 2 atrasadas + 3 de hoje = 5 no total. Com o limite de 3 (atrasadas
    // primeiro), esperado: as 2 atrasadas + 1 de hoje, com "Ver todas".
    await criarTask('Atrasada Um', ontem1)
    await criarTask('Atrasada Dois', ontem2)
    await criarTask('Hoje Um', hoje1)
    await criarTask('Hoje Dois', hoje2)
    await criarTask('Hoje Três', hoje3)

    const page = await abrirDashboard()
    const cartao = page.locator('.card', { has: page.locator('h2', { hasText: 'Precisa da sua atenção' }) })

    const linhas = cartao.locator('.attn-row')
    expect(await linhas.count()).toBe(3)

    const titulos = await linhas.locator('.attn-name').allInnerTexts()
    expect(titulos).toEqual(['Atrasada Um', 'Atrasada Dois', 'Hoje Um'])

    // As duas atrasadas tem o prazo destacado; a de hoje, nao.
    expect(await linhas.nth(0).locator('.attn-prazo-atrasado').count()).toBe(1)
    expect(await linhas.nth(1).locator('.attn-prazo-atrasado').count()).toBe(1)
    expect(await linhas.nth(2).locator('.attn-prazo-atrasado').count()).toBe(0)

    // Ha mais (2 pendencias de hoje ficaram de fora): link "Ver todas".
    const verTodas = cartao.locator('a:has-text("Ver todas as pendências")')
    expect(await verTodas.count()).toBe(1)

    // Clicar num item ou no "Ver todas" abre /pendencias.
    await Promise.all([page.waitForURL(/\/pendencias/, { timeout: 30_000 }), verTodas.click()])
    await page.close()
  })

  it('clicar numa pendência específica também abre /pendencias', async () => {
    const page = await abrirDashboard()
    const cartao = page.locator('.card', { has: page.locator('h2', { hasText: 'Precisa da sua atenção' }) })
    const primeiraLinha = cartao.locator('.attn-row').first()
    await Promise.all([page.waitForURL(/\/pendencias/, { timeout: 30_000 }), primeiraLinha.click()])
    await page.close()
  })
})
