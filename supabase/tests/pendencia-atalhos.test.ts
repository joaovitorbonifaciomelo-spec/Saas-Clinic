/**
 * =============================================================================
 * "CRIAR PENDÊNCIA" EM PACIENTE E AGENDAMENTO — NO NAVEGADOR
 * =============================================================================
 *
 * Mesmo formulário de /pendencias (NovaPendencia), aberto a partir de duas
 * telas novas: a ficha do paciente e o detalhe do agendamento. Navegador
 * real, API real, banco de Dev real — mesma disciplina de
 * pendencias-ui.test.ts e do describe equivalente em atendimento-ui.test.ts.
 *
 * Agendamento sempre tem paciente (patientId nao e nullable no schema), entao
 * so existe UM cenario relevante ali — nao ha "agendamento sem paciente" para
 * testar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import type { SupabaseClient } from '@supabase/supabase-js'
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
let accessToken: string
let clinicId: string
let patientId: string
let appointmentId: string
let dateKey: string

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${env.apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-clinic-id': clinicId,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}

beforeAll(async () => {
  env = loadIsolationEnv()
  admin = createAdminClient(env)
  registry = new TestResourceRegistry(env.url)

  const [apiSaude, web] = await Promise.all([
    fetch(`${env.apiUrl}/api/health`).catch(() => null),
    fetch(`${WEB}/login`).catch(() => null),
  ])
  if (apiSaude?.ok !== true) throw new Error(`API precisa estar no ar em ${env.apiUrl}.`)
  if (web?.ok !== true) throw new Error(`App Next precisa estar no ar em ${WEB}.`)

  browser = await chromium.launch()

  const email = `atalhos-${registry.testRunId}@example.test`
  const password = `Senha-Teste-${registry.testRunId}!`
  const { data: userData, error: userErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Marina Costa', test_run_id: registry.testRunId },
  })
  if (userErr || !userData.user) throw new Error(`criar usuario: ${userErr?.message}`)
  registry.registerUser(userData.user.id)

  const db = createAnonClient(env)
  const { data: signIn, error: signInErr } = await db.auth.signInWithPassword({ email, password })
  if (signInErr || !signIn.session) throw new Error(`login: ${signInErr?.message}`)
  accessToken = signIn.session.access_token

  const { data: clinica, error: clinicaErr } = await db
    .rpc('create_clinic_with_owner', { p_name: `Clinica Atalhos ${registry.testRunId.slice(0, 8)}` })
    .single<{ id: string }>()
  if (clinicaErr || !clinica) throw new Error(`criar clinica: ${clinicaErr?.message}`)
  clinicId = clinica.id
  registry.registerClinic(clinicId)

  const { data: paciente, error: pacienteErr } = await db
    .from('patients')
    .insert({ clinic_id: clinicId, name: 'Joana Ribeiro', phone: '11988887777' })
    .select('id')
    .single()
  if (pacienteErr || !paciente) throw new Error(`criar paciente: ${pacienteErr?.message}`)
  patientId = paciente.id as string

  const { data: profissional, error: profErr } = await db
    .from('professionals')
    .insert({ clinic_id: clinicId, name: 'Dra. Atalhos' })
    .select('id')
    .single()
  if (profErr || !profissional) throw new Error(`criar profissional: ${profErr?.message}`)

  // Disponibilidade cobrindo os 7 dias, dia inteiro — o teste nao quer
  // testar avisos de disponibilidade, so precisa criar UM agendamento limpo.
  const disponibilidade = Array.from({ length: 7 }, (_, weekday) => ({
    clinic_id: clinicId,
    professional_id: profissional.id as string,
    weekday,
    start_time: '00:00:00',
    end_time: '23:59:00',
  }))
  const { error: dispErr } = await db.from('professional_availability').insert(disponibilidade)
  if (dispErr) throw new Error(`criar disponibilidade: ${dispErr.message}`)

  // 15h UTC cai no MESMO dia local em qualquer fuso razoavel (inclusive
  // America/Sao_Paulo, UTC-3): evita o agendamento cair no dia de amanha ou
  // ontem so por causa do fuso da clinica.
  const hoje = new Date()
  const inicio = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 15, 0, 0))
  dateKey = inicio.toISOString().slice(0, 10)

  const criado = await api('/api/appointments', {
    method: 'POST',
    body: JSON.stringify({
      patientId,
      professionalId: profissional.id as string,
      startsAt: inicio.toISOString(),
      endsAt: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
    }),
  })
  if (criado.status !== 201) {
    throw new Error(`criar agendamento: ${criado.status} ${JSON.stringify(criado.body)}`)
  }
  appointmentId = criado.body.id as string

  ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto('/login', { waitUntil: 'networkidle' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
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

describe('criar pendência a partir da ficha do paciente', () => {
  it('sem seletor de paciente, avisa o vínculo, e a pendência sai com patientId correto', async () => {
    const page = await ctx.newPage()
    await page.goto(`/patients?p=${patientId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.patient-head', { timeout: 30_000 })

    await page.click('button:has-text("Criar pendência")')
    await page.waitForSelector('.pd-drawer', { timeout: 30_000 })

    // Nao ha select de paciente aqui — so o de responsavel.
    expect(await page.locator('.pd-drawer select').count()).toBe(1)
    expect(await page.locator('.pd-drawer').innerText()).toContain('Vinculada a Joana Ribeiro.')

    const titulo = `Pendencia da ficha ${registry.testRunId.slice(0, 6)}`
    await page.fill('.pd-drawer input:not([type])', titulo)
    await page.click('.pd-drawer button:has-text("Criar pendência")')

    await page.waitForSelector('.pt-aviso:has-text("Pendência criada")', { timeout: 30_000 })
    expect(await page.locator('.pd-drawer').count()).toBe(0)
    expect(page.url()).toContain('/patients')

    const { data: tarefa } = await admin
      .from('tasks')
      .select('patient_id, conversation_id, appointment_id, title')
      .eq('title', titulo)
      .single()
    expect(tarefa?.patient_id).toBe(patientId)
    expect(tarefa?.conversation_id).toBeNull()
    expect(tarefa?.appointment_id).toBeNull()

    await page.close()
  })
})

describe('criar pendência a partir do agendamento', () => {
  it('avisa o vínculo ao agendamento e ao paciente, e a pendência sai com os dois ids corretos', async () => {
    const page = await ctx.newPage()
    await page.goto(`/agenda?view=day&date=${dateKey}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.ag-appt', { timeout: 30_000 })

    await page.click('.ag-appt:has-text("Joana Ribeiro")')
    await page.waitForSelector('.status-panel', { timeout: 30_000 })

    await page.click('.status-panel button:has-text("Criar pendência")')
    await page.waitForSelector('.pd-drawer', { timeout: 30_000 })
    expect(await page.locator('.pd-drawer').innerText()).toContain(
      'Vinculada a este agendamento e a Joana Ribeiro.',
    )

    const titulo = `Pendencia do agendamento ${registry.testRunId.slice(0, 6)}`
    await page.fill('.pd-drawer input:not([type])', titulo)
    await page.click('.pd-drawer button:has-text("Criar pendência")')

    await page.waitForSelector('.ag-aviso:has-text("Pendência criada")', { timeout: 30_000 })
    expect(await page.locator('.pd-drawer').count()).toBe(0)
    expect(page.url()).toContain('/agenda')

    const { data: tarefa } = await admin
      .from('tasks')
      .select('patient_id, appointment_id, title')
      .eq('title', titulo)
      .single()
    expect(tarefa?.appointment_id).toBe(appointmentId)
    expect(tarefa?.patient_id).toBe(patientId)

    await page.close()
  })
})
