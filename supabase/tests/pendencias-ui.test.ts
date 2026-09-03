/**
 * =============================================================================
 * PENDENCIAS — COMPORTAMENTO DA TELA, NO NAVEGADOR
 * =============================================================================
 *
 * Testa a tela de verdade: navegador real, sessao real, API real, banco de
 * desenvolvimento real. Mesma disciplina de `atendimento-ui.test.ts` — nao ha
 * mock, e o que este arquivo prova e que a pessoa consegue fazer o trabalho
 * dela pela tela, nao so que a API responde certo.
 *
 * SOBRE O CASO invalid_state QUE NAO ESTA AQUI, DE PROPOSITO:
 *
 * O drawer ESCONDE proativamente as acoes que nao cabem no estado atual (uma
 * pendencia terminal so mostra "Reabrir"). Isso e a decisao de produto certa
 * — prevenir e melhor que deixar tentar e explicar depois —, mas tem uma
 * consequencia para o teste: qualquer corrida real entre duas pessoas sempre
 * diverge a VERSAO junto com o estado, porque toda mutacao de dominio bumpa
 * versao. O primeiro cheque do backend e sempre a versao (de proposito — ver
 * "stale version tem precedencia" abaixo), entao quem chega depois sempre cai
 * em `task_conflict`, nunca em `task_invalid_state`, mesmo tentando uma acao
 * que o estado novo proibiria. `task_invalid_state` so e alcancavel por um
 * cliente que mande uma versao CORRETA para uma acao que o estado ja proibe —
 * e um cliente correto, com o drawer escondendo os botoes, nunca monta essa
 * requisicao. Cobrimos isso indiretamente: o teste "terminal esconde as
 * acoes erradas" prova que a tela nunca da a chance de mandar a requisicao
 * invalida em primeiro lugar.
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

interface Ator {
  userId: string
  email: string
  password: string
  nome: string
  clinicId: string
  patientId: string
  ctx: BrowserContext
}

let maria: Ator
let joao: Ator

async function criarUsuario(rotulo: string, nome: string) {
  const email = `pd-ui-${rotulo}-${registry.testRunId}@example.test`
  const password = `Senha-Teste-${registry.testRunId}!`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: nome, test_run_id: registry.testRunId },
  })
  if (error || !data.user) throw new Error(`${rotulo}: ${error?.message}`)
  registry.registerUser(data.user.id)
  return { userId: data.user.id, email, password, nome }
}

async function logar(email: string, password: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto('/login', { waitUntil: 'networkidle' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', password)
  await Promise.all([
    page.waitForURL(/dashboard|onboarding/, { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ])
  await page.close()
  return ctx
}

/** Abre Pendencias e espera a lista montar. */
async function abrirPendencias(ctx: BrowserContext, sufixo = ''): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto(`/pendencias${sufixo}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.pd-shell', { timeout: 30_000 })
  return page
}

/** Cria uma pendencia pela API, direto — o teste de UI nao precisa passar
 *  pelo formulario para MONTAR o cenario, so para testar o formulario em si. */
async function semearPendencia(
  ator: Ator,
  title: string,
  extra: { dueAt?: string | null; patientId?: string | null } = {},
): Promise<string> {
  const db = createAnonClient(env)
  await db.auth.signInWithPassword({ email: ator.email, password: ator.password })
  const { data, error } = await db.rpc('task_create', {
    p_clinic_id: ator.clinicId,
    p_title: title,
    p_description: null,
    p_due_at: extra.dueAt ?? null,
    p_assignee_id: null,
    p_patient_id: extra.patientId ?? null,
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

  const m = await criarUsuario('maria', 'Maria Souza')
  const j = await criarUsuario('joao', 'João Lima')

  const dbM = createAnonClient(env)
  await dbM.auth.signInWithPassword({ email: m.email, password: m.password })
  const { data: clinica } = await dbM
    .rpc('create_clinic_with_owner', { p_name: `Clinica Pendencias UI ${registry.testRunId.slice(0, 8)}` })
    .single<{ id: string }>()
  registry.registerClinic(clinica!.id)
  await admin
    .from('clinic_members')
    .insert({ clinic_id: clinica!.id, user_id: j.userId, role: 'attendant' })

  const { data: paciente } = await dbM
    .from('patients')
    .insert({ clinic_id: clinica!.id, name: 'Joana Ribeiro', phone: '11988887777' })
    .select('id')
    .single()

  maria = { ...m, clinicId: clinica!.id, patientId: paciente!.id as string, ctx: await logar(m.email, m.password) }
  joao = { ...j, clinicId: clinica!.id, patientId: paciente!.id as string, ctx: await logar(j.email, j.password) }
}, 300_000)

afterAll(async () => {
  await maria?.ctx.close().catch(() => {})
  await joao?.ctx.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (registry) await registry.cleanup(admin)
}, 180_000)

/* ===========================================================================
   Navegacao
   ======================================================================== */
describe('entrada no modulo', () => {
  it('Pendências aparece na navegação lateral', async () => {
    const page = await maria.ctx.newPage()
    await page.goto('/dashboard', { waitUntil: 'networkidle' })
    const link = page.locator('.sidebar a[href="/pendencias"]')
    expect(await link.count()).toBe(1)
    expect(await link.innerText()).toContain('Pendências')
    await page.close()
  })
})

/* ===========================================================================
   Criacao
   ======================================================================== */
describe('criar pendência', () => {
  it('pendência geral, sem contexto, aparece na lista', async () => {
    const page = await abrirPendencias(maria.ctx)
    const titulo = `Revisar encaixes ${registry.testRunId.slice(0, 6)}`

    await page.click('button:has-text("Nova pendência")')
    await page.waitForSelector('.pd-drawer')
    await page.fill('.pd-drawer input:not([type])', titulo)
    await page.click('.pd-drawer button:has-text("Criar pendência")')

    await page.waitForSelector('.pd-drawer-titulo', { timeout: 30_000 })
    expect(await page.locator('.pd-drawer-titulo').innerText()).toBe(titulo)
    // Sem paciente, conversa ou agendamento: o drawer diz isso explicitamente,
    // em vez de deixar um espaco em branco que parece dado faltando.
    expect(await page.locator('.pd-drawer-corpo').innerText()).toContain(
      'Pendência geral da clínica',
    )
    await page.close()
  })

  it('com paciente vinculado, mostra o contexto e o link para o paciente', async () => {
    const page = await abrirPendencias(maria.ctx)
    const titulo = `Cobrar exame ${registry.testRunId.slice(0, 6)}`

    await page.click('button:has-text("Nova pendência")')
    await page.waitForSelector('.pd-drawer')
    await page.fill('.pd-drawer input:not([type])', titulo)

    // Seleciona pelo VALOR da opcao que contem o nome — mais robusto do que
    // casar o texto formatado inteiro (nome + telefone formatado).
    const seletorPaciente = page.locator('.pd-drawer select').nth(1)
    const valorPaciente = await seletorPaciente
      .locator('option', { hasText: 'Joana Ribeiro' })
      .getAttribute('value')
    await seletorPaciente.selectOption(valorPaciente!)

    await page.click('.pd-drawer button:has-text("Criar pendência")')

    await page.waitForSelector('.pd-drawer-titulo', { timeout: 30_000 })
    const corpo = page.locator('.pd-drawer-corpo')
    expect(await corpo.innerText()).toContain('Joana Ribeiro')
    expect(await page.locator('a:has-text("Ver paciente")').count()).toBe(1)
    await page.close()
  })
})

/* ===========================================================================
   Detalhe, edicao e prazo
   ======================================================================== */
describe('drawer de detalhe', () => {
  it('editar título e descrição reflete na lista', async () => {
    const id = await semearPendencia(maria, `Título velho ${registry.testRunId.slice(0, 6)}`)
    // Sem prazo: so aparece na lista sob a visao "Sem prazo" — a visao padrao
    // (Hoje) exclui tarefa sem due_at por definicao do filtro due=today.
    const page = await abrirPendencias(maria.ctx, `?v=undated&id=${id}`)
    await page.waitForSelector('.pd-drawer-titulo')

    await page.click('button:has-text("Editar título/descrição")')
    const novoTitulo = `Título novo ${registry.testRunId.slice(0, 6)}`
    await page.fill('.pd-form input', novoTitulo)
    await page.fill('.pd-form textarea', 'Ligar para confirmar o horário.')
    await page.click('.pd-form button:has-text("Salvar")')

    await page.waitForSelector(`.pd-drawer-titulo:has-text("${novoTitulo}")`, { timeout: 30_000 })
    expect(await page.locator(`.pd-item-titulo:has-text("${novoTitulo}")`).count()).toBe(1)
    await page.close()
  })

  it('definir e depois remover o prazo', async () => {
    const id = await semearPendencia(maria, `Sem prazo ainda ${registry.testRunId.slice(0, 6)}`)
    const page = await abrirPendencias(maria.ctx, `?id=${id}`)
    await page.waitForSelector('.pd-drawer-titulo')
    expect(await page.locator('.pd-bloco').first().innerText()).toContain('Sem prazo definido')

    await page.click('button:has-text("Definir prazo")')
    const daqui30dias = new Date(Date.now() + 30 * 86_400_000)
    const valor = daqui30dias.toISOString().slice(0, 16)
    await page.fill('input[type="datetime-local"]', valor)
    await page.click('.pd-prazo-form button:has-text("Salvar")')

    await page.waitForSelector('button:has-text("Alterar")', { timeout: 30_000 })
    expect(await page.locator('.pd-bloco').first().innerText()).not.toContain('Sem prazo definido')

    await page.click('button:has-text("Remover")')
    await page.waitForSelector('button:has-text("Definir prazo")', { timeout: 30_000 })
    expect(await page.locator('.pd-bloco').first().innerText()).toContain('Sem prazo definido')
    await page.close()
  })
})

/* ===========================================================================
   Responsavel: atribuir, transferir, devolver
   ======================================================================== */
describe('responsável', () => {
  it('atribuir a um colega: ator e destinatário aparecem certos no histórico', async () => {
    const id = await semearPendencia(maria, `Para o colega ${registry.testRunId.slice(0, 6)}`)
    const page = await abrirPendencias(maria.ctx, `?id=${id}`)
    await page.waitForSelector('.pd-drawer-titulo')

    await page.click('button:has-text("Atribuir a…")')
    await page.waitForSelector('.pd-pop')

    /*
     * COR, e nao so texto — mesma guarda de `atendimento-ui.test.ts`. O reset
     * global estiliza `button` como primario (fundo da marca, texto BRANCO);
     * `.pd-equipe-item` troca o fundo por branco e herdaria a cor se a
     * correcao nao estivesse aplicada. So a leitura de estilo computado pega
     * essa classe de bug — innerText passa mesmo com o texto invisivel.
     */
    const contraste = await page.locator('.pd-equipe-item').first().evaluate((el) => {
      const janela = globalThis as unknown as {
        getComputedStyle: (e: unknown) => { color: string; backgroundColor: string }
      }
      const estilo = janela.getComputedStyle(el)
      return { cor: estilo.color, fundo: estilo.backgroundColor }
    })
    expect(contraste.cor).not.toBe(contraste.fundo)
    expect(contraste.cor).not.toMatch(/255,\s*255,\s*255/)

    await page.click('.pd-equipe-item:has-text("João Lima")')
    await page.waitForSelector('.pd-linha-acao:has-text("João Lima")', { timeout: 30_000 })

    // ATOR (quem executou = Maria) e DESTINATARIO (quem recebeu = João) sao
    // pessoas diferentes, e o historico precisa dizer os dois papeis certos.
    const historico = await page.locator('.pd-historico').innerText()
    expect(historico).toMatch(/Maria Souza atribuiu a João Lima/)
    await page.close()
  })

  it('transferir, depois devolver à fila', async () => {
    const id = await semearPendencia(maria, `Transferir ${registry.testRunId.slice(0, 6)}`)
    const page = await abrirPendencias(maria.ctx, `?id=${id}`)
    await page.waitForSelector('.pd-drawer-titulo')

    await page.click('button:has-text("Assumir")')
    await page.waitForSelector('button:has-text("Transferir")', { timeout: 30_000 })

    await page.click('button:has-text("Transferir")')
    await page.waitForSelector('.pd-pop')
    await page.click('.pd-equipe-item:has-text("João Lima")')
    await page.waitForSelector('.pd-linha-acao:has-text("João Lima")', { timeout: 30_000 })

    await page.click('button:has-text("Devolver à fila")')
    await page.waitForSelector('text=Sem responsável — fila geral', { timeout: 30_000 })
    await page.close()
  })
})

/* ===========================================================================
   Status: concluir, cancelar, reabrir
   ======================================================================== */
describe('ciclo de status', () => {
  it('concluir pela ação rápida da lista', async () => {
    const titulo = `Concluir rápido ${registry.testRunId.slice(0, 6)}`
    await semearPendencia(maria, titulo)
    // Mesma razao: sem due_at, so aparece sob a visao "Sem prazo".
    const page = await abrirPendencias(maria.ctx, '?v=undated')

    const linha = page.locator('.pd-item', { has: page.locator(`.pd-item-titulo:has-text("${titulo}")`) })
    await linha.locator('.pd-item-concluir').click()

    // "Sem prazo" (como toda visao de aberta) filtra status=open: ao concluir,
    // a linha some da lista — nao fica ali com um badge atualizado. E o
    // comportamento certo de fila operacional: o item feito sai do caminho.
    await page.waitForSelector(`.pd-item-titulo:has-text("${titulo}")`, {
      state: 'detached',
      timeout: 30_000,
    })
    await page.close()
  })

  it('terminal esconde as ações que não cabem no estado, mostra só Reabrir', async () => {
    const id = await semearPendencia(maria, `Cancelar e reabrir ${registry.testRunId.slice(0, 6)}`)
    const page = await abrirPendencias(maria.ctx, `?id=${id}`)
    await page.waitForSelector('.pd-drawer-titulo')

    await page.click('button:has-text("Cancelar pendência")')
    await page.waitForSelector('.pd-terminal-nota', { timeout: 30_000 })

    const corpo = page.locator('.pd-drawer-corpo')
    expect(await corpo.locator('button:has-text("Editar")').count()).toBe(0)
    expect(await corpo.locator('button:has-text("Definir prazo")').count()).toBe(0)
    expect(await corpo.locator('button:has-text("Assumir")').count()).toBe(0)
    expect(await page.locator('.pd-drawer-pe button:has-text("Reabrir")').count()).toBe(1)

    await page.click('.pd-drawer-pe button:has-text("Reabrir")')
    await page.waitForSelector('.pd-drawer-pe button:has-text("Concluir")', { timeout: 30_000 })

    // O historico preserva os DOIS fatos — cancelou e reabriu — mesmo que o
    // estado atual da tarefa nao mostre mais nenhum sinal do cancelamento.
    const historico = await page.locator('.pd-historico').innerText()
    expect(historico).toMatch(/cancelou a pendência/)
    expect(historico).toMatch(/reabriu a pendência/)
    await page.close()
  })
})

/* ===========================================================================
   Concorrencia
   ======================================================================== */
describe('concorrência', () => {
  it('versão obsoleta vira aviso humano, sem número de versão, e a tela se corrige sozinha', async () => {
    const id = await semearPendencia(maria, `Conflito ${registry.testRunId.slice(0, 6)}`)

    // As duas telas carregam a MESMA versao.
    const pMaria = await abrirPendencias(maria.ctx, `?id=${id}`)
    const pJoao = await abrirPendencias(joao.ctx, `?id=${id}`)

    // Joao conclui primeiro; a tela de Maria continua com a versao antiga,
    // porque ela nao navegou nem focou a aba de novo desde que abriu.
    await pJoao.click('.pd-drawer-pe button:has-text("Concluir")')
    await pJoao.waitForSelector('.pd-terminal-nota', { timeout: 30_000 })

    await pMaria.click('.pd-drawer-pe button:has-text("Concluir")')
    await pMaria.waitForSelector('.pd-aviso', { timeout: 30_000 })

    const aviso = await pMaria.locator('.pd-aviso').innerText()
    expect(aviso).toMatch(/outra pessoa alterou/i)
    // Nada de "version 2": e detalhe de implementacao, nao linguagem humana.
    expect(aviso).not.toMatch(/vers[aã]o \d|version/i)

    // A tela ja mostra o estado real — terminal, com Reabrir — sem reload.
    await pMaria.waitForSelector('.pd-terminal-nota', { timeout: 30_000 })
    await pMaria.close()
    await pJoao.close()
  })
})
