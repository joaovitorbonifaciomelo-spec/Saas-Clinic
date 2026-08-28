/**
 * =============================================================================
 * ATENDIMENTO — COMPORTAMENTO DA TELA, NO NAVEGADOR
 * =============================================================================
 *
 * Testa a tela de verdade: navegador real, sessao real, API real, banco de
 * desenvolvimento real. Nao ha mock — o que este arquivo prova e que a pessoa
 * consegue fazer o trabalho dela, e que a tela nao promete nada que o sistema
 * nao faz.
 *
 * Duas afirmacoes aqui existem por motivo de produto, nao de codigo:
 *
 *   - a faixa "Modo manual" esta visivel, sempre;
 *   - o botao diz "Registrar mensagem" e NUNCA "Enviar".
 *
 * Se alguma das duas cair, a equipe da clinica passa a acreditar que respondeu
 * um paciente que nunca foi respondido.
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
  const email = `ui-${rotulo}-${registry.testRunId}@example.test`
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

/** Abre o Atendimento e espera a fila montar. */
async function abrirAtendimento(ctx: BrowserContext, sufixo = ''): Promise<Page> {
  const page = await ctx.newPage()
  await page.goto(`/atendimento${sufixo}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.at-shell', { timeout: 30_000 })
  return page
}

/** Cria conversa pela API, direto — o teste da UI nao precisa passar pelo form. */
async function semearConversa(
  ator: Ator,
  nome: string,
  telefone: string | null = null,
  patientId: string | null = null,
): Promise<string> {
  const db = createAnonClient(env)
  await db.auth.signInWithPassword({ email: ator.email, password: ator.password })
  const { data, error } = await db.rpc('conversation_create_manual', {
    p_clinic_id: ator.clinicId,
    p_contact_phone_e164: telefone,
    p_contact_name_snapshot: nome,
    p_patient_id: patientId,
  })
  if (error) throw new Error(error.message)
  return (data as { conversation: { id: string } }).conversation.id
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

  // Maria cria a clinica (vira admin); João entra como atendente.
  const dbM = createAnonClient(env)
  await dbM.auth.signInWithPassword({ email: m.email, password: m.password })
  const { data: clinica } = await dbM
    .rpc('create_clinic_with_owner', { p_name: `Clinica UI ${registry.testRunId.slice(0, 8)}` })
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

  maria = {
    ...m,
    clinicId: clinica!.id,
    patientId: paciente!.id as string,
    ctx: await logar(m.email, m.password),
  }
  joao = {
    ...j,
    clinicId: clinica!.id,
    patientId: paciente!.id as string,
    ctx: await logar(j.email, j.password),
  }
}, 300_000)

afterAll(async () => {
  await maria?.ctx.close().catch(() => {})
  await joao?.ctx.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (registry) await registry.cleanup(admin)
}, 180_000)

/* ===========================================================================
   Navegacao e estado vazio
   ======================================================================== */
describe('entrada no modulo', () => {
  it('o Atendimento aparece na navegacao lateral', async () => {
    const page = await maria.ctx.newPage()
    await page.goto('/dashboard', { waitUntil: 'networkidle' })
    const link = page.locator('.sidebar a[href="/atendimento"]')
    expect(await link.count()).toBe(1)
    expect(await link.innerText()).toContain('Atendimento')
    await page.close()
  })

  it('fila vazia explica o modo manual e oferece a acao', async () => {
    const page = await abrirAtendimento(maria.ctx)
    const texto = await page.locator('.at-shell').innerText()

    expect(texto).toContain('Nenhum atendimento por aqui.')
    // O estado vazio ensina o que a tela faz, em vez de so dizer que esta vazia.
    expect(texto).toMatch(/telefone|balcão/i)
    expect(await page.locator('button:has-text("Novo atendimento manual")').count()).toBe(1)
    await page.close()
  })
})

/* ===========================================================================
   Criacao
   ======================================================================== */
describe('novo atendimento manual', () => {
  it('cria pelo formulario e abre a conversa', async () => {
    const page = await abrirAtendimento(maria.ctx)
    await page.click('.master-meta button:has-text("Novo atendimento")')
    await page.waitForSelector('.at-drawer')

    // O formulario NAO oferece canal, provedor, status nem responsavel.
    const campos = await page.locator('.at-form label').allInnerTexts()
    expect(campos.join(' ')).not.toMatch(/canal|provedor|status|responsável/i)

    await page.fill('.at-form input >> nth=0', 'Pedro Alves')
    await page.fill('.at-form input >> nth=1', '(11) 97777-6666')
    await Promise.all([
      page.waitForURL(/\/atendimento\?c=/, { timeout: 30_000 }),
      page.click('.at-form-pe button[type="submit"]'),
    ])

    await page.waitForSelector('.at-thread-nome')
    expect(await page.locator('.at-thread-nome').innerText()).toContain('Pedro Alves')
    await page.close()
  })

  it('telefone repetido abre o atendimento existente, sem erro', async () => {
    const telefone = '(11) 96666-5555'
    const page = await abrirAtendimento(maria.ctx)

    await page.click('.master-meta button:has-text("Novo atendimento")')
    await page.waitForSelector('.at-drawer')
    await page.fill('.at-form input >> nth=0', 'Primeira Vez')
    await page.fill('.at-form input >> nth=1', telefone)
    await Promise.all([
      page.waitForURL(/\/atendimento\?c=/, { timeout: 30_000 }),
      page.click('.at-form-pe button[type="submit"]'),
    ])
    const primeiraUrl = page.url()

    await page.click('.master-meta button:has-text("Novo atendimento")')
    await page.waitForSelector('.at-drawer')
    await page.fill('.at-form input >> nth=0', 'Outro Nome')
    await page.fill('.at-form input >> nth=1', telefone)
    await page.click('.at-form-pe button[type="submit"]')

    // Nao e erro: abrimos a thread que ja existia e avisamos discretamente.
    await page.waitForSelector('.at-aviso', { timeout: 30_000 })
    expect(await page.locator('.at-aviso').innerText()).toMatch(/já existia/i)
    expect(page.url()).toBe(primeiraUrl)
    await page.close()
  })

  it('telefone invalido nao cria e explica', async () => {
    const page = await abrirAtendimento(maria.ctx)
    await page.click('.master-meta button:has-text("Novo atendimento")')
    await page.waitForSelector('.at-drawer')
    await page.fill('.at-form input >> nth=0', 'Numero Ruim')
    await page.fill('.at-form input >> nth=1', '123')
    await page.click('.at-form-pe button[type="submit"]')

    await page.waitForSelector('.at-form .error')
    expect(await page.locator('.at-form .error').innerText()).toMatch(/telefone inválido/i)
    await page.close()
  })
})

/* ===========================================================================
   Modo manual — as duas afirmacoes de produto
   ======================================================================== */
describe('modo manual', () => {
  it('a faixa esta visivel e diz exatamente o que acontece', async () => {
    const id = await semearConversa(maria, 'Contato Faixa')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    const faixa = page.locator('.at-modo-manual')
    expect(await faixa.isVisible()).toBe(true)
    const texto = await faixa.innerText()
    expect(texto).toContain('Modo manual')
    expect(texto).toContain('não são enviadas nem recebidas pelo WhatsApp')
    await page.close()
  })

  it('o botao diz Registrar, nunca Enviar', async () => {
    const id = await semearConversa(maria, 'Contato Botao')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    const botao = page.locator('.at-composer button[type="submit"]')
    expect(await botao.innerText()).toContain('Registrar mensagem')

    // Nenhuma palavra da tela pode sugerir envio ou integracao ativa.
    const tela = await page.locator('.at-shell').innerText()
    expect(tela).not.toMatch(/\bEnviar\b/)
    expect(tela).not.toMatch(/WhatsApp conectado|online|entregue|lida/i)
    await page.close()
  })
})

/* ===========================================================================
   Thread e composer
   ======================================================================== */
describe('registro de mensagens', () => {
  it('registra mensagem do paciente e da equipe, com autoria correta', async () => {
    const id = await semearConversa(maria, 'Contato Thread')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    // Paciente falou.
    await page.click('.at-direcao button:has-text("Paciente falou")')
    await page.fill('.at-composer textarea', 'Bom dia, posso remarcar?')
    await page.click('.at-composer button[type="submit"]')
    await page.waitForSelector('.at-msg.is-contato', { timeout: 30_000 })

    // Equipe respondeu.
    await page.click('.at-direcao button:has-text("Equipe respondeu")')
    await page.fill('.at-composer textarea', 'Claro, tenho quinta as 10.')
    await page.click('.at-composer button[type="submit"]')
    await page.waitForSelector('.at-msg.is-equipe', { timeout: 30_000 })

    const recebida = page.locator('.at-msg.is-contato').first()
    const enviada = page.locator('.at-msg.is-equipe').first()

    expect(await recebida.innerText()).toContain('Bom dia, posso remarcar?')
    // Em mensagem recebida, quem digitou NAO e quem falou — e isso aparece.
    expect(await recebida.innerText()).toMatch(/registrado por Maria/i)

    expect(await enviada.innerText()).toContain('Claro, tenho quinta as 10.')
    expect(await enviada.innerText()).toContain('Maria Souza')
    await page.close()
  })

  it('o texto sobrevive quando o registro falha', async () => {
    const id = await semearConversa(maria, 'Contato Falha')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    // Derruba a chamada da action para simular rede ruim.
    await page.route('**/atendimento**', (route) =>
      route.request().method() === 'POST' ? route.abort() : route.continue(),
    )
    await page.fill('.at-composer textarea', 'Texto que nao pode sumir')
    await page.click('.at-composer button[type="submit"]').catch(() => {})
    await page.waitForTimeout(1500)

    // Quem escreveu nao pode perder o que digitou porque a rede falhou.
    expect(await page.locator('.at-composer textarea').inputValue()).toBe(
      'Texto que nao pode sumir',
    )
    await page.unroute('**/atendimento**')
    await page.close()
  })

  it('mensagem recebida reabre atendimento encerrado, e o evento e do sistema', async () => {
    const id = await semearConversa(maria, 'Contato Reabre')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    await page.click('button:has-text("Encerrar")')
    await page.waitForSelector('.badge.at-st-resolved', { timeout: 30_000 })

    await page.click('.at-direcao button:has-text("Paciente falou")')
    await page.fill('.at-composer textarea', 'Oi, voltei.')
    await page.click('.at-composer button[type="submit"]')

    await page.waitForSelector('.badge.at-st-open', { timeout: 30_000 })
    // Seletor de texto do Playwright: nao precisa de `document`, que nao
    // existe no ambiente de tipos destes testes.
    await page.waitForSelector('.at-linha:has-text("reaberto")', { timeout: 30_000 })
    const linha = await page.locator('.at-linha').innerText()
    // A frase nao atribui a reabertura a quem registrou a mensagem.
    expect(linha).toMatch(/reaberto/i)
    expect(linha).not.toMatch(/Maria Souza reabriu/i)
    await page.close()
  })
})

/* ===========================================================================
   Controle
   ======================================================================== */
describe('acoes de controle', () => {
  it('assumir, aguardando paciente, encerrar e reabrir', async () => {
    const id = await semearConversa(maria, 'Contato Ciclo')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    await page.click('button:has-text("Assumir")')
    await page.waitForSelector('button:has-text("Devolver à fila")', { timeout: 30_000 })
    expect(await page.locator('.at-thread-meta').innerText()).toContain('Você')

    await page.click('button:has-text("Aguardando paciente")')
    await page.waitForSelector('.badge.at-st-waiting_patient', { timeout: 30_000 })

    await page.click('button:has-text("Encerrar")')
    await page.waitForSelector('.badge.at-st-resolved', { timeout: 30_000 })

    await page.click('button:has-text("Reabrir")')
    await page.waitForSelector('.badge.at-st-open', { timeout: 30_000 })
    await page.close()
  })

  it('devolver a fila remove o responsavel', async () => {
    const id = await semearConversa(maria, 'Contato Release')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    await page.click('button:has-text("Assumir")')
    await page.waitForSelector('button:has-text("Devolver à fila")', { timeout: 30_000 })
    await page.click('button:has-text("Devolver à fila")')

    await page.waitForSelector('button:has-text("Assumir")', { timeout: 30_000 })
    expect(await page.locator('.at-thread-meta').innerText()).toContain('Sem responsável')
    await page.close()
  })

  it('transferir usa o diretorio da equipe, sem e-mail', async () => {
    const id = await semearConversa(maria, 'Contato Transfer')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    await page.click('button:has-text("Assumir")')
    await page.waitForSelector('button:has-text("Transferir")', { timeout: 30_000 })
    await page.click('button:has-text("Transferir")')
    await page.waitForSelector('.at-equipe')

    const equipe = await page.locator('.at-equipe').innerText()
    expect(equipe).toContain('João Lima')
    expect(equipe).toContain('Recepção')
    // Diretorio e para operacao, nao para expor contato de ninguem.
    expect(equipe).not.toContain('@')

    await page.click('.at-equipe-item:has-text("João Lima")')
    await page.waitForSelector('.at-thread-meta:has-text("João Lima")', { timeout: 30_000 })
    await page.close()
  })

  it('conflito de versao vira aviso humano, sem numero de versao', async () => {
    const id = await semearConversa(maria, 'Contato Conflito')

    // As duas telas carregam a MESMA versao.
    const pMaria = await abrirAtendimento(maria.ctx, `?c=${id}`)
    const pJoao = await abrirAtendimento(joao.ctx, `?c=${id}`)

    // João assume primeiro; a tela de Maria continua na versao antiga.
    await pJoao.click('button:has-text("Assumir")')
    await pJoao.waitForSelector('button:has-text("Devolver à fila")', { timeout: 30_000 })

    await pMaria.click('button:has-text("Assumir")')
    await pMaria.waitForSelector('.at-aviso', { timeout: 30_000 })

    const aviso = await pMaria.locator('.at-aviso').innerText()
    expect(aviso).toMatch(/outra pessoa alterou/i)
    // Nada de "version 3": isso e detalhe de implementacao.
    expect(aviso).not.toMatch(/vers[aã]o \d|version/i)

    // E a tela ja mostra o estado real, sem recarregar.
    await pMaria.waitForSelector('.at-thread-meta:has-text("João Lima")', { timeout: 30_000 })
    await pMaria.close()
    await pJoao.close()
  })
})

/* ===========================================================================
   Paciente
   ======================================================================== */
describe('contexto do paciente', () => {
  it('sem vinculo, oferece vincular ou criar', async () => {
    const id = await semearConversa(maria, 'Contato Sem Paciente')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    const ctx = await page.locator('.at-contexto').innerText()
    expect(ctx).toContain('Paciente não identificado')
    expect(await page.locator('button:has-text("Vincular paciente existente")').count()).toBe(1)
    expect(await page.locator('a:has-text("Criar novo paciente")').count()).toBe(1)
    await page.close()
  })

  it('vincular e desvincular funcionam pela tela', async () => {
    const id = await semearConversa(maria, 'Contato Vinculo')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    await page.click('button:has-text("Vincular paciente existente")')
    await page.waitForSelector('.at-pacientes', { timeout: 30_000 })
    await page.click('.at-paciente-item:has-text("Joana Ribeiro")')

    await page.waitForSelector('.at-paciente-nome', { timeout: 30_000 })
    expect(await page.locator('.at-paciente-nome').innerText()).toContain('Joana Ribeiro')

    await page.click('button:has-text("Desvincular paciente")')
    await page.waitForSelector('.at-sem-paciente-titulo', { timeout: 30_000 })
    await page.close()
  })

  it('trocar de paciente orienta desvincular antes — nao troca escondido', async () => {
    // Segundo paciente, para haver troca possivel.
    const dbM = createAnonClient(env)
    await dbM.auth.signInWithPassword({ email: maria.email, password: maria.password })
    await dbM
      .from('patients')
      .insert({ clinic_id: maria.clinicId, name: 'Carlos Prado', phone: '11955554444' })

    const id = await semearConversa(maria, 'Contato Troca', null, maria.patientId)
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)

    // Ja ha paciente: a tela nao oferece "vincular outro" como atalho.
    expect(await page.locator('.at-contexto').innerText()).toContain('Joana Ribeiro')
    expect(await page.locator('button:has-text("Vincular paciente existente")').count()).toBe(0)
    expect(await page.locator('button:has-text("Desvincular paciente")').count()).toBe(1)
    await page.close()
  })
})

/* ===========================================================================
   Fila: filtros, busca, selecao
   ======================================================================== */
describe('fila', () => {
  it('busca por nome encontra o atendimento', async () => {
    await semearConversa(maria, 'Fulano Buscavel', '+5511911112222')
    const page = await abrirAtendimento(maria.ctx)

    await page.fill('.at-fila input[type="search"]', 'Fulano')
    await page.press('.at-fila input[type="search"]', 'Enter')
    await page.waitForSelector('.at-item', { timeout: 30_000 })
    expect(await page.locator('.at-lista').innerText()).toContain('Fulano Buscavel')
    await page.close()
  })

  it('filtro por visao muda a fila', async () => {
    const id = await semearConversa(maria, 'Contato Encerrada')
    const page = await abrirAtendimento(maria.ctx, `?c=${id}`)
    await page.click('button:has-text("Encerrar")')
    await page.waitForSelector('.badge.at-st-resolved', { timeout: 30_000 })

    await page.click('.at-visoes a:has-text("Encerradas")')
    await page.waitForSelector('.at-visao.is-on:has-text("Encerradas")', { timeout: 30_000 })
    expect(await page.locator('.at-lista').innerText()).toContain('Contato Encerrada')

    await page.click('.at-visoes a:has-text("Sem responsável")')
    await page.waitForSelector('.at-visao.is-on:has-text("Sem responsável")', { timeout: 30_000 })
    await page.close()
  })

  it('selecionar item troca a conversa e mantem a fila montada', async () => {
    const a = await semearConversa(maria, 'Primeiro Contato')
    await semearConversa(maria, 'Segundo Contato')
    const page = await abrirAtendimento(maria.ctx, `?c=${a}`)

    await page.click('.at-item:has-text("Segundo Contato")')
    await page.waitForSelector('.at-thread-nome:has-text("Segundo Contato")', { timeout: 30_000 })
    // A fila continua no lugar: nao houve recarga de pagina inteira.
    expect(await page.locator('.at-lista').isVisible()).toBe(true)
    await page.close()
  })
})

/* ===========================================================================
   Responsivo
   ======================================================================== */
describe('responsivo', () => {
  it('mobile mostra uma area por vez', async () => {
    const id = await semearConversa(maria, 'Contato Mobile')
    const ctx = await browser.newContext({
      baseURL: WEB,
      viewport: { width: 390, height: 780 },
      storageState: await maria.ctx.storageState(),
    })
    const page = await ctx.newPage()

    await page.goto('/atendimento', { waitUntil: 'networkidle' })
    await page.waitForSelector('.at-shell')
    // Sem conversa aberta: a fila ocupa a tela.
    expect(await page.locator('.at-lista').isVisible()).toBe(true)

    await page.click(`.at-item:has-text("Contato Mobile")`)
    await page.waitForSelector('.at-thread-nome', { timeout: 30_000 })
    // Agora a conversa ocupa a tela, e ha caminho de volta.
    expect(await page.locator('.at-voltar').isVisible()).toBe(true)
    expect(await page.locator('.at-lista').isVisible()).toBe(false)

    await page.click('.at-voltar')
    expect(await page.locator('.at-lista').isVisible()).toBe(true)
    await ctx.close()
    expect(id).toBeTruthy()
  })

  it('tablet leva o contexto do paciente para gaveta', async () => {
    const id = await semearConversa(maria, 'Contato Tablet')
    const ctx = await browser.newContext({
      baseURL: WEB,
      viewport: { width: 1024, height: 800 },
      storageState: await maria.ctx.storageState(),
    })
    const page = await ctx.newPage()
    await page.goto(`/atendimento?c=${id}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.at-thread-nome')

    // Fora da tela ate alguem pedir.
    const classes = () => page.locator('.at-contexto').getAttribute('class')
    expect(await classes()).not.toMatch(/is-aberto/)
    await page.click('.at-ver-contexto')
    await page.waitForSelector('.at-contexto.is-aberto', { timeout: 15_000 })
    expect(await classes()).toMatch(/is-aberto/)
    await ctx.close()
  })
})
