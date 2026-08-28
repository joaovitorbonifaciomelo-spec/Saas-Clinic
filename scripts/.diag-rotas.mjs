import { config } from 'dotenv'
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
config({ path: 'D:/Projeto Piloto Clinicas/.env.test' })
const m = JSON.parse(readFileSync('D:/Projeto Piloto Clinicas/.diag/manifesto.json', 'utf8'))
const WEB = process.env.ALVO ?? 'https://saas-clinic-web.vercel.app'
const b = await chromium.launch()
const ctx = await b.newContext({ baseURL: WEB, viewport: { width: 1280, height: 800 } })
ctx.setDefaultTimeout(90_000); ctx.setDefaultNavigationTimeout(90_000)
const lp = await ctx.newPage()
await lp.goto('/login', { waitUntil: 'domcontentloaded' })
await lp.fill('input[name="email"]', m.email); await lp.fill('input[name="password"]', m.senha)
await Promise.all([lp.waitForURL(/dashboard|onboarding/), lp.click('button[type="submit"]')])
await lp.close()
const p = await ctx.newPage()
const rotas = process.env.ROTAS?.split(',') ?? ['/dashboard', '/patients', '/atendimento', '/agenda']
for (const rota of rotas) {
  const t0 = Date.now()
  try {
    const r = await p.goto(rota, { waitUntil: 'domcontentloaded' })
    const txt = await p.locator('body').innerText().catch(() => '')
    const digest = /ERROR (\d+)/.exec(txt)?.[1] ?? ''
    console.log(`${String(r?.status()).padEnd(4)} ${rota.padEnd(24)} ${Date.now() - t0}ms ${digest ? 'digest ' + digest : ''}`)
  } catch (e) {
    console.log(`ERR  ${rota.padEnd(24)} ${Date.now() - t0}ms ${e.message.slice(0, 50)}`)
  }
}
await b.close()
