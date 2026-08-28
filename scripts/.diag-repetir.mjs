import { config } from 'dotenv'
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { setTimeout as esperar } from 'node:timers/promises'
config({ path: 'D:/Projeto Piloto Clinicas/.env.test' })
const m = JSON.parse(readFileSync('D:/Projeto Piloto Clinicas/.diag/manifesto.json', 'utf8'))
const WEB = 'https://saas-clinic-web.vercel.app'
const b = await chromium.launch()
const ctx = await b.newContext({ baseURL: WEB })
ctx.setDefaultTimeout(180_000); ctx.setDefaultNavigationTimeout(180_000)
const lp = await ctx.newPage()
await lp.goto('/login', { waitUntil: 'domcontentloaded' })
await lp.fill('input[name="email"]', m.email); await lp.fill('input[name="password"]', m.senha)
await Promise.all([lp.waitForURL(/dashboard|onboarding/), lp.click('button[type="submit"]')])
await lp.close()
const p = await ctx.newPage()
console.log('  tentativa  regiao  isolada                          paralelas ok/erro')
for (let i = 1; i <= 6; i += 1) {
  await p.goto('/diag/r7k2p9x4m1', { waitUntil: 'domcontentloaded' })
  const j = JSON.parse(await p.locator('body').innerText())
  const iso = j.isolada.status ? `HTTP ${j.isolada.status} em ${j.isolada.ms}ms` : `${j.isolada.causa?.[1] ?? j.isolada.erro} (${j.isolada.ms}ms)`
  const ok = j.paralelas.filter((x) => x.status).length
  console.log(`  ${String(i).padEnd(11)}${String(j.regiao).padEnd(8)}${iso.slice(0, 32).padEnd(34)}${ok}/${5 - ok}`)
  if (i < 6) await esperar(20_000)
}
await b.close()
