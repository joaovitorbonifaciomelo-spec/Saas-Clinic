import { config } from 'dotenv'
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
config({ path: 'D:/Projeto Piloto Clinicas/.env.test' })
const m = JSON.parse(readFileSync('D:/Projeto Piloto Clinicas/.diag/manifesto.json', 'utf8'))
const WEB = process.env.ALVO ?? 'https://saas-clinic-web.vercel.app'
const b = await chromium.launch()
const ctx = await b.newContext({ baseURL: WEB })
ctx.setDefaultTimeout(180_000); ctx.setDefaultNavigationTimeout(180_000)
const lp = await ctx.newPage()
await lp.goto('/login', { waitUntil: 'domcontentloaded' })
await lp.fill('input[name="email"]', m.email); await lp.fill('input[name="password"]', m.senha)
await Promise.all([lp.waitForURL(/dashboard|onboarding/), lp.click('button[type="submit"]')])
await lp.close()
const p = await ctx.newPage()
const r = await p.goto('/diag/r7k2p9x4m1', { waitUntil: 'domcontentloaded' })
console.log('status:', r?.status())
console.log(await p.locator('body').innerText())
await b.close()
