/**
 * =============================================================================
 * AGENDA — VISAO MES, NO NAVEGADOR
 * =============================================================================
 *
 * A visao Mes e panorama e navegacao, nao detalhe. O que este arquivo garante:
 *
 *   - a grade desenha semanas inteiras, com os dias vizinhos em tom secundario;
 *   - o dia cheio nao estica a celula — vira "+N mais", que leva ao Dia;
 *   - o filtro de profissional e a navegacao entre meses valem aqui tambem;
 *   - a URL sozinha reconstroi a tela, para refresh e voltar funcionarem;
 *   - o mes inteiro custa UMA consulta a API, nao uma por dia.
 *
 * Fixtures por run id, limpas pelo manifesto. Nenhum dado real de clinica.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
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
let db: SupabaseClient

let clinicId = ''
let profA = { id: '', name: 'Dra. Helena Marques' }
let profB = { id: '', name: 'Dr. Rafael Nunes' }

/** Mes de referencia: sempre o corrente, para "Hoje" ter o que provar. */
const agora = new Date()
const ANO = agora.getUTCFullYear()
const MES = agora.getUTCMonth() + 1
const MES_KEY = `${ANO}-${String(MES).padStart(2, '0')}`
const DIA_CHEIO = 17

const MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
]

/** "Agosto de 2026" para o mes corrente deslocado de N meses. */
function rotuloDoMes(deslocamento: number): string {
  const total = ANO * 12 + (MES - 1) + deslocamento
  return `${MESES[total % 12]} de ${Math.floor(total / 12)}`
}

async function abrir(rota: string): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto(rota, { waitUntil: 'networkidle' })
  return page
}

async function abrirMes(sufixo = ''): Promise<Page> {
  const page = await abrir(`/agenda?view=month&date=${MES_KEY}-01${sufixo}`)
  await page.waitForSelector('.mes', { timeout: 30_000 })
  return page
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

  const email = `mes-${registry.testRunId}@example.test`
  const password = `Senha-Teste-${registry.testRunId}!`
  const { data: u, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Maria Souza', test_run_id: registry.testRunId },
  })
  if (error || !u.user) throw new Error(`usuario: ${error?.message}`)
  registry.registerUser(u.user.id)

  db = createAnonClient(env)
  await db.auth.signInWithPassword({ email, password })
  const { data: clinica } = await db
    .rpc('create_clinic_with_owner', { p_name: `Clinica Mes ${registry.testRunId.slice(0, 8)}` })
    .single<{ id: string }>()
  registry.registerClinic(clinica!.id)
  clinicId = clinica!.id

  const { data: profs } = await db
    .from('professionals')
    .insert([
      { clinic_id: clinicId, name: profA.name, specialty: 'Clínica geral' },
      { clinic_id: clinicId, name: profB.name, specialty: 'Ortopedia' },
    ])
    .select('id, name')
  profA = { ...profA, id: profs!.find((p) => p.name === profA.name)!.id as string }
  profB = { ...profB, id: profs!.find((p) => p.name === profB.name)!.id as string }

  const { data: servico } = await db
    .from('services')
    .insert({ clinic_id: clinicId, name: 'Consulta', duration_minutes: 30 })
    .select('id')
    .single()

  const { data: pacientes } = await db
    .from('patients')
    .insert(
      ['Joana Ribeiro', 'Carlos Prado', 'Marina Souza', 'Pedro Alves', 'Rita Camargo'].map(
        (name, i) => ({ clinic_id: clinicId, name, phone: `1198888${2000 + i}` }),
      ),
    )
    .select('id, name')

  const linhas: Record<string, unknown>[] = []
  let n = 0
  const marcar = (dia: number, hora: number, prof: string, status: string) => {
    const inicio = new Date(Date.UTC(ANO, MES - 1, dia, hora + 3, 0))
    linhas.push({
      clinic_id: clinicId,
      patient_id: pacientes![n % pacientes!.length]!.id,
      professional_id: prof,
      service_id: servico!.id,
      starts_at: inicio.toISOString(),
      ends_at: new Date(inicio.getTime() + 30 * 60_000).toISOString(),
      status,
    })
    n += 1
  }

  marcar(3, 9, profA.id, 'confirmed')
  marcar(4, 10, profB.id, 'scheduled')
  marcar(11, 15, profB.id, 'cancelled')
  // Dia cheio: 7 agendamentos, para o "+N mais" existir.
  for (let i = 0; i < 7; i += 1) marcar(DIA_CHEIO, 8 + i, i % 2 === 0 ? profA.id : profB.id, 'confirmed')

  const { error: erroIns } = await db.from('appointments').insert(linhas)
  if (erroIns) throw new Error(erroIns.message)

  ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 } })
  const login = await ctx.newPage()
  await login.goto('/login', { waitUntil: 'networkidle' })
  await login.fill('input[name="email"]', email)
  await login.fill('input[name="password"]', password)
  await Promise.all([
    login.waitForURL(/dashboard|onboarding/, { timeout: 60_000 }),
    login.click('button[type="submit"]'),
  ])
  await login.close()
}, 300_000)

afterAll(async () => {
  await ctx?.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (registry) await registry.cleanup(admin)
}, 180_000)

/* ===========================================================================
   Grade
   ======================================================================== */
describe('grade do mes', () => {
  it('desenha semanas inteiras, de domingo a sabado', async () => {
    const page = await abrirMes()

    const cabecalho = await page.locator('.mes-head').innerText()
    expect(cabecalho.toLowerCase().replace(/\s+/g, ' ').trim()).toBe('dom seg ter qua qui sex sáb')

    const celulas = await page.locator('.mes-cel').count()
    // Toda grade mensal tem 4, 5 ou 6 semanas completas — nunca uma parcial.
    expect(celulas % 7).toBe(0)
    expect(celulas).toBeGreaterThanOrEqual(28)
    expect(celulas).toBeLessThanOrEqual(42)
    await page.close()
  })

  it('dias de outro mes aparecem, em tom secundario', async () => {
    const page = await abrirMes()
    const fora = await page.locator('.mes-cel.fora').count()
    const doMes = await page.locator('.mes-cel:not(.fora)').count()

    // O mes inteiro esta presente; os vizinhos existem para fechar a semana.
    expect(doMes).toBeGreaterThanOrEqual(28)
    expect(fora + doMes).toBe(await page.locator('.mes-cel').count())
    await page.close()
  })

  it('o titulo e o mes por extenso', async () => {
    const page = await abrirMes()
    const periodo = await page.locator('.tb-period').innerText()
    expect(periodo).toMatch(/^(Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro) de \d{4}$/)
    await page.close()
  })

  it('o dia de hoje tem destaque', async () => {
    const page = await abrirMes()
    expect(await page.locator('.mes-cel.hoje').count()).toBe(1)
    await page.close()
  })

  it('mes sem agendamentos mostra a grade vazia, nao um erro', async () => {
    // Um mes distante, onde nao ha nada marcado.
    const page = await abrir(`/agenda?view=month&date=${ANO + 3}-06-01`)
    await page.waitForSelector('.mes')
    expect(await page.locator('.mes-item').count()).toBe(0)
    expect(await page.locator('.mes-cel').count()).toBeGreaterThan(0)
    await page.close()
  })
})

/* ===========================================================================
   Conteudo dos dias
   ======================================================================== */
describe('agendamentos nos dias', () => {
  it('mostra hora e nome, de forma compacta', async () => {
    const page = await abrirMes()
    const cel = page.locator(`.mes-cel[data-dia="${MES_KEY}-03"]`)
    const texto = await cel.innerText()

    expect(texto).toContain('09:00')
    expect(texto).toContain('Joana Ribeiro')
    // Nao repete o detalhe da visao Dia.
    expect(texto).not.toMatch(/Ortopedia|Clínica geral|Consulta/)
    await page.close()
  })

  it('status aparece com cor, e cancelado fica secundario', async () => {
    const page = await abrirMes()
    const confirmado = page.locator(`.mes-cel[data-dia="${MES_KEY}-03"] .mes-item`)
    expect(await confirmado.getAttribute('class')).toContain('confirmed')

    const cancelado = page.locator(`.mes-cel[data-dia="${MES_KEY}-11"] .mes-item`)
    expect(await cancelado.getAttribute('class')).toContain('cancelled')
    const opacidade = await cancelado.evaluate((el) => {
      const janela = globalThis as unknown as {
        getComputedStyle: (e: unknown) => { opacity: string }
      }
      return Number(janela.getComputedStyle(el).opacity)
    })
    expect(opacidade).toBeLessThan(1)
    await page.close()
  })

  it('dia cheio vira "+N mais" e nao estica a celula', async () => {
    const page = await abrirMes()
    const cheio = page.locator(`.mes-cel[data-dia="${MES_KEY}-${DIA_CHEIO}"]`)
    const vazio = page.locator(`.mes-cel[data-dia="${MES_KEY}-13"]`)

    // Tres visiveis e o resto no "+N mais".
    expect(await cheio.locator('.mes-item').count()).toBe(3)
    expect(await cheio.locator('.mes-mais').innerText()).toContain('+ 4')

    // A altura da celula nao cresce com o numero de agendamentos.
    const alturaCheia = (await cheio.boundingBox())!.height
    const alturaVazia = (await vazio.boundingBox())!.height
    expect(alturaCheia).toBe(alturaVazia)
    await page.close()
  })

  it('"+N mais" leva a visao Dia daquela data', async () => {
    const page = await abrirMes()
    await page.click(`.mes-cel[data-dia="${MES_KEY}-${DIA_CHEIO}"] .mes-mais`)
    await page.waitForURL(new RegExp(`view=day.*date=${MES_KEY}-${DIA_CHEIO}`), { timeout: 30_000 })
    await page.waitForSelector('.agenda-grid', { timeout: 30_000 })
    await page.close()
  })
})

/* ===========================================================================
   Interacoes
   ======================================================================== */
describe('interacoes', () => {
  it('clicar no numero do dia abre a visao Dia', async () => {
    const page = await abrirMes()
    await page.click(`.mes-cel[data-dia="${MES_KEY}-03"] .mes-num`)
    await page.waitForURL(new RegExp(`view=day.*date=${MES_KEY}-03`), { timeout: 30_000 })
    await page.close()
  })

  it('clicar num agendamento abre o mesmo drawer de sempre', async () => {
    const page = await abrirMes()
    await page.click(`.mes-cel[data-dia="${MES_KEY}-03"] .mes-item`)
    await page.waitForSelector('.drawer', { timeout: 30_000 })
    expect(await page.locator('.drawer').innerText()).toContain('Joana Ribeiro')
    await page.close()
  })

  it('clicar num dia vazio abre criacao naquela data', async () => {
    const page = await abrirMes()
    await page.click(`.mes-cel[data-dia="${MES_KEY}-13"] .mes-vazio`, { force: true })
    await page.waitForSelector('.drawer', { timeout: 30_000 })
    // A data ja vem preenchida: o clique disse qual dia era.
    expect(await page.locator('.drawer input[type="date"]').inputValue()).toBe(`${MES_KEY}-13`)
    await page.close()
  })
})

/* ===========================================================================
   Navegacao e filtro
   ======================================================================== */
describe('navegacao', () => {
  it('mes anterior e proximo andam de MES, nao de 30 dias', async () => {
    const page = await abrirMes()
    expect(await page.locator('.tb-period').innerText()).toBe(rotuloDoMes(0))

    // Afirmar o mes exato, e nao so "mudou": somar 30 dias acertaria em varios
    // meses e erraria em fevereiro, e um teste de "mudou" nao veria isso.
    await page.click('button[aria-label="Período anterior"]')
    await page.waitForSelector(`.tb-period:has-text("${rotuloDoMes(-1)}")`, { timeout: 30_000 })

    await page.click('button[aria-label="Próximo período"]')
    await page.waitForSelector(`.tb-period:has-text("${rotuloDoMes(0)}")`, { timeout: 30_000 })

    await page.click('button[aria-label="Próximo período"]')
    await page.waitForSelector(`.tb-period:has-text("${rotuloDoMes(1)}")`, { timeout: 30_000 })
    await page.close()
  })

  it('o rotulo responde imediatamente ao clique', async () => {
    const page = await abrirMes()

    await page.click('button[aria-label="Próximo período"]')
    // Prazo curto de proposito: o padrao otimista de Dia/Semana vale aqui
    // tambem, entao o rotulo troca antes de a rede responder.
    await page.waitForSelector(`.tb-period:has-text("${rotuloDoMes(1)}")`, { timeout: 1500 })
    await page.close()
  })

  it('Hoje volta ao mes atual', async () => {
    const page = await abrir(`/agenda?view=month&date=${ANO + 1}-01-01`)
    await page.waitForSelector('.mes')
    await page.click('button:has-text("Hoje")')
    await page.waitForSelector('.mes-cel.hoje', { timeout: 30_000 })
    await page.close()
  })

  it('filtro de profissional funciona no mes', async () => {
    const page = await abrirMes(`&professional=${profA.id}`)
    const cheio = page.locator(`.mes-cel[data-dia="${MES_KEY}-${DIA_CHEIO}"]`)

    // Sem filtro sao 7 no dia cheio; com filtro, so os de uma profissional.
    const semFiltro = await abrirMes()
    const totalSemFiltro = await semFiltro
      .locator(`.mes-cel[data-dia="${MES_KEY}-${DIA_CHEIO}"] .mes-item, .mes-cel[data-dia="${MES_KEY}-${DIA_CHEIO}"] .mes-mais`)
      .count()
    await semFiltro.close()

    const visiveis = await cheio.locator('.mes-item').count()
    const mais = await cheio.locator('.mes-mais').count()
    expect(visiveis + mais).toBeLessThan(totalSemFiltro + 1)
    // E o dia de profB some da grade filtrada.
    expect(await page.locator(`.mes-cel[data-dia="${MES_KEY}-04"] .mes-item`).count()).toBe(0)
    await page.close()
  })

  it('alternar Dia -> Semana -> Mes preserva a data', async () => {
    const page = await abrir(`/agenda?date=${MES_KEY}-03`)
    await page.waitForSelector('.agenda-grid')

    await page.click('.seg button:has-text("Semana")')
    await page.waitForURL(/view=week/, { timeout: 30_000 })

    await page.click('.seg button:has-text("Mês")')
    await page.waitForURL(/view=month/, { timeout: 30_000 })
    await page.waitForSelector('.mes')
    expect(page.url()).toContain(`date=${MES_KEY}-03`)
    await page.close()
  })

  it('a URL sozinha reconstroi a tela', async () => {
    const page = await abrir(
      `/agenda?view=month&date=${MES_KEY}-01&professional=${profA.id}`,
    )
    await page.waitForSelector('.mes')

    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.mes')
    // Depois do refresh continua no Mes, no mesmo mes e com o mesmo filtro.
    expect(await page.locator('.seg button[aria-pressed="true"]').innerText()).toBe('Mês')
    expect(await page.locator('.tb-select').inputValue()).toBe(profA.id)
    await page.close()
  })
})

/* ===========================================================================
   Custo
   ======================================================================== */
describe('custo', () => {
  it('o mes inteiro custa UMA consulta de agendamentos', async () => {
    const page = await ctx.newPage()
    const chamadas: string[] = []
    await page.route('**/api/appointments*', (route) => {
      chamadas.push(route.request().url())
      return route.continue()
    })

    // As chamadas saem do SERVIDOR do Next, entao a rota do navegador nao as
    // ve. O que da para afirmar aqui e que a tela nao dispara uma busca por
    // dia a partir do cliente — que e exatamente o N+1 que se teme.
    await page.goto(`/agenda?view=month&date=${MES_KEY}-01`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.mes')
    await page.waitForTimeout(1200)

    expect(chamadas.length).toBeLessThanOrEqual(1)
    await page.unroute('**/api/appointments*')
    await page.close()
  })
})

/* ===========================================================================
   Responsivo
   ======================================================================== */
describe('responsivo', () => {
  it('no celular a grade vira mapa de densidade', async () => {
    const mob = await browser.newContext({
      baseURL: WEB,
      viewport: { width: 390, height: 844 },
      storageState: await ctx.storageState(),
    })
    const page = await mob.newPage()
    await page.goto(`/agenda?view=month&date=${MES_KEY}-01`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.mes')

    // Hora e nome nao cabem em 7 colunas de 390px; a contagem cabe.
    expect(await page.locator('.mes-itens').first().isVisible()).toBe(false)
    const contagem = page.locator(`.mes-cel[data-dia="${MES_KEY}-${DIA_CHEIO}"] .mes-contagem`)
    expect(await contagem.isVisible()).toBe(true)
    expect(await contagem.innerText()).toBe('7')

    // A grade inteira continua na tela, sem rolagem horizontal.
    const larguraGrade = (await page.locator('.mes').boundingBox())!.width
    expect(larguraGrade).toBeLessThanOrEqual(390)
    await mob.close()
  })
})
