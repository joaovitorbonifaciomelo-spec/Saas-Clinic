/**
 * Experimento de concorrencia contra o Funnel.
 *
 * A pagina da agenda dispara 5 chamadas em paralelo. A pergunta e se a taxa de
 * falha cresce com o numero de conexoes simultaneas — uma chamada isolada pode
 * parecer saudavel e a pagina ainda assim falhar.
 *
 * Mede por requisicao: DNS, TCP connect, TLS handshake, TTFB e total, usando os
 * tempos que o proprio agente do Node expoe.
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { connect as tlsConnect } from 'node:tls'
import { lookup } from 'node:dns/promises'
import { Socket } from 'node:net'
import { setTimeout as esperar } from 'node:timers/promises'
config({ path: 'D:/Projeto Piloto Clinicas/.env.test' })

const HOST = 'srv1779541.taild2349f.ts.net'
const m = JSON.parse(readFileSync('D:/Projeto Piloto Clinicas/.diag/manifesto.json', 'utf8'))

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})
const { data: s } = await db.auth.signInWithPassword({ email: m.email, password: m.senha })
const H = {
  Authorization: `Bearer ${s.session.access_token}`,
  'x-clinic-id': m.clinics[0],
}

/** Uma requisicao HTTPS crua, com as fases separadas. */
function medir(caminho) {
  return new Promise((resolve) => {
    const t = { dns: 0, tcp: 0, tls: 0, ttfb: 0, total: 0 }
    const t0 = Date.now()
    let tDns = 0
    let tTcp = 0
    let tTls = 0

    lookup(HOST).then(
      ({ address }) => {
        tDns = Date.now()
        t.dns = tDns - t0
        const sock = new Socket()
        sock.setTimeout(30_000)
        sock.on('timeout', () => {
          sock.destroy()
          resolve({ ...t, total: Date.now() - t0, erro: 'TCP_TIMEOUT', fase: 'A' })
        })
        sock.on('error', (e) =>
          resolve({ ...t, total: Date.now() - t0, erro: e.code ?? e.message, fase: 'A' }),
        )
        sock.connect(443, address, () => {
          tTcp = Date.now()
          t.tcp = tTcp - tDns
          const tls = tlsConnect({ socket: sock, servername: HOST }, () => {
            tTls = Date.now()
            t.tls = tTls - tTcp
            tls.write(
              `GET ${caminho} HTTP/1.1\r\nHost: ${HOST}\r\n` +
                Object.entries(H)
                  .map(([k, v]) => `${k}: ${v}\r\n`)
                  .join('') +
                `Connection: close\r\n\r\n`,
            )
            let primeiro = 0
            let corpo = ''
            tls.on('data', (d) => {
              if (!primeiro) {
                primeiro = Date.now()
                t.ttfb = primeiro - tTls
              }
              corpo += d.toString('utf8', 0, Math.min(d.length, 200))
            })
            tls.on('end', () => {
              t.total = Date.now() - t0
              const status = /HTTP\/1\.\d (\d{3})/.exec(corpo)?.[1] ?? '???'
              resolve({ ...t, status, fase: status.startsWith('2') ? 'ok' : 'D' })
            })
          })
          tls.setTimeout(30_000, () => {
            tls.destroy()
            resolve({ ...t, total: Date.now() - t0, erro: 'TLS_TIMEOUT', fase: 'B' })
          })
          tls.on('error', (e) =>
            resolve({ ...t, total: Date.now() - t0, erro: e.code ?? e.message, fase: 'B' }),
          )
        })
      },
      (e) => resolve({ ...t, total: Date.now() - t0, erro: `DNS ${e.code}`, fase: 'DNS' }),
    )
  })
}

const CAMINHOS = [
  '/api/health',
  '/api/me',
  '/api/professionals',
  '/api/services?active=true',
  '/api/patients',
]

function resumo(rs) {
  const ok = rs.filter((r) => r.fase === 'ok')
  const falhas = rs.filter((r) => r.fase !== 'ok')
  const med = (k) => {
    const v = ok.map((r) => r[k]).sort((a, b) => a - b)
    return v.length ? v[Math.floor(v.length / 2)] : 0
  }
  return {
    ok: ok.length,
    falhas: falhas.length,
    dns: med('dns'),
    tcp: med('tcp'),
    tls: med('tls'),
    ttfb: med('ttfb'),
    total: med('total'),
    erros: [...new Set(falhas.map((f) => `${f.fase}:${f.erro ?? f.status}`))],
  }
}

console.log('\n  CONCORRENCIA CONTRA O FUNNEL (daqui)')
console.log('  ' + '-'.repeat(74))
console.log(
  '    ' +
    'paralelas'.padEnd(11) +
    'ok'.padEnd(6) +
    'falhas'.padEnd(8) +
    'dns'.padEnd(7) +
    'tcp'.padEnd(7) +
    'tls'.padEnd(8) +
    'ttfb'.padEnd(8) +
    'total',
)

for (const n of [1, 2, 5, 10]) {
  const todas = []
  for (let rodada = 0; rodada < 3; rodada += 1) {
    const lote = Array.from({ length: n }, (_, i) => medir(CAMINHOS[i % CAMINHOS.length]))
    todas.push(...(await Promise.all(lote)))
    await esperar(500)
  }
  const s = resumo(todas)
  console.log(
    `    ${String(n).padEnd(11)}${String(s.ok).padEnd(6)}${String(s.falhas).padEnd(8)}` +
      `${(s.dns + 'ms').padEnd(7)}${(s.tcp + 'ms').padEnd(7)}${(s.tls + 'ms').padEnd(8)}` +
      `${(s.ttfb + 'ms').padEnd(8)}${s.total}ms` +
      (s.erros.length ? `   ${s.erros.join(', ')}` : ''),
  )
}
console.log('')
