/**
 * Fuso da clinica, contra o Supabase real.
 *
 * O risco que estas asserções cobrem (R3) e concreto: `now()` no banco e UTC, e
 * Sao Paulo esta 3 horas atras. Uma pendencia marcada para hoje as 21h local
 * cai em 00h UTC do DIA SEGUINTE — se o corte do dia fosse feito em UTC, ela
 * sumiria de "Hoje" justamente no fim do expediente, que e quando as pendencias
 * se acumulam. O sintoma chegaria como "a tarefa sumiu", e ninguem ligaria a
 * causa.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { montarCenario, novaTask, type Cenario } from './task-helpers'

let c: Cenario
let fuso: string

beforeAll(async () => {
  c = await montarCenario()
  const { data } = await c.admin
    .from('clinics')
    .select('timezone')
    .eq('id', c.maria.clinicId)
    .single()
  fuso = (data as { timezone: string }).timezone
}, 120_000)

afterAll(async () => {
  await c?.registry.cleanup(c.admin)
}, 120_000)

/* =============================================================================
   Cortes de dia no fuso da clinica

   O mesmo calculo que a API vai fazer: o intervalo do dia sai do fuso da
   CLINICA e viaja como dois instantes absolutos. A consulta continua um range
   simples sobre `due_at` e continua usando indice.
   ========================================================================== */

/** Quanto o fuso esta deslocado do UTC naquele instante. */
function deslocamentoMs(tz: string, quando: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p = Object.fromEntries(
    dtf.formatToParts(quando).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]),
  ) as Record<string, string>
  const comoUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  )
  return comoUtc - quando.getTime()
}

function inicioDoDiaLocal(tz: string, quando = new Date()): Date {
  const deslocado = new Date(quando.getTime() + deslocamentoMs(tz, quando))
  deslocado.setUTCHours(0, 0, 0, 0)
  // Recalcula o deslocamento NA meia-noite: num pais com horario de verao, o
  // deslocamento do meio-dia pode nao valer para a meia-noite do mesmo dia.
  const tentativa = new Date(deslocado.getTime() - deslocamentoMs(tz, quando))
  return new Date(deslocado.getTime() - deslocamentoMs(tz, tentativa))
}

const maisDias = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

describe('cortes de dia', () => {
  it('a clinica tem fuso IANA declarado', () => {
    expect(fuso).toBe('America/Sao_Paulo')
  })

  it('a virada do dia local NAO coincide com a virada UTC', () => {
    const inicio = inicioDoDiaLocal(fuso)
    // Meia-noite em Sao Paulo e 03:00 UTC. Se fossem iguais, todo o resto
    // destes testes passaria por acidente.
    expect(inicio.getUTCHours()).not.toBe(0)
  })
})

describe('particao completa das pendencias abertas', () => {
  it('atrasada, hoje, proxima e sem prazo cobrem tudo, sem sobreposicao', async () => {
    const agora = new Date()
    const inicioHoje = inicioDoDiaLocal(fuso, agora)
    const fimHoje = maisDias(inicioHoje, 1)

    /*
     * A borda que importa: 21h em Sao Paulo e 00h UTC do dia seguinte. Se o
     * corte fosse feito em UTC, esta tarefa cairia em "Proximas" — e sumiria de
     * "Hoje" no fim do expediente.
     */
    const fimDoExpediente = new Date(fimHoje.getTime() - 3 * 3_600_000) // 21h local

    const criadas = {
      atrasada: await novaTask(c.maria.db, c.maria.clinicId, {
        title: 'Venceu ontem',
        dueAt: new Date(inicioHoje.getTime() - 1000).toISOString(),
      }),
      inicioDeHoje: await novaTask(c.maria.db, c.maria.clinicId, {
        title: 'Meia-noite local',
        dueAt: inicioHoje.toISOString(),
      }),
      fimDeHoje: await novaTask(c.maria.db, c.maria.clinicId, {
        title: 'Ultimo segundo do dia local',
        dueAt: new Date(fimHoje.getTime() - 1000).toISOString(),
      }),
      viradaUtc: await novaTask(c.maria.db, c.maria.clinicId, {
        title: '21h local, ja e amanha em UTC',
        dueAt: fimDoExpediente.toISOString(),
      }),
      proxima: await novaTask(c.maria.db, c.maria.clinicId, {
        title: 'Primeiro instante de amanha',
        dueAt: fimHoje.toISOString(),
      }),
      semPrazo: await novaTask(c.maria.db, c.maria.clinicId, { title: 'Assim que possivel' }),
    }

    const base = () => c.maria.db.from('tasks').select('id').eq('status', 'open')

    const [atrasadas, hoje, proximas, semPrazo, abertas] = await Promise.all([
      base().lt('due_at', inicioHoje.toISOString()),
      base().gte('due_at', inicioHoje.toISOString()).lt('due_at', fimHoje.toISOString()),
      base().gte('due_at', fimHoje.toISOString()),
      base().is('due_at', null),
      base(),
    ])

    const ids = (r: { data: { id: string }[] | null }) => new Set((r.data ?? []).map((x) => x.id))
    const setAtrasadas = ids(atrasadas)
    const setHoje = ids(hoje)
    const setProximas = ids(proximas)
    const setSemPrazo = ids(semPrazo)

    expect(setAtrasadas.has(criadas.atrasada.id)).toBe(true)
    expect(setHoje.has(criadas.inicioDeHoje.id)).toBe(true)
    expect(setHoje.has(criadas.fimDeHoje.id)).toBe(true)
    expect(setProximas.has(criadas.proxima.id)).toBe(true)
    expect(setSemPrazo.has(criadas.semPrazo.id)).toBe(true)

    // O caso de R3, isolado: 21h local e HOJE, e nao "amanha".
    expect(setHoje.has(criadas.viradaUtc.id)).toBe(true)
    expect(setProximas.has(criadas.viradaUtc.id)).toBe(false)

    // PARTICAO: cada pendencia aberta cai em exatamente uma das quatro. Nao e
    // detalhe de UI — e a garantia de que nenhuma pendencia aberta some, que e
    // o que o modulo promete.
    const todas = (abertas.data ?? []).map((x) => x.id)
    expect(todas.length).toBeGreaterThanOrEqual(6)
    for (const id of todas) {
      const em = [setAtrasadas, setHoje, setProximas, setSemPrazo].filter((s) => s.has(id))
      expect(em).toHaveLength(1)
    }
  })

  it('concluir tira a pendencia das quatro visoes de aberta', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Sai da fila ao concluir',
      dueAt: new Date(Date.now() - 3_600_000).toISOString(),
    })
    await c.maria.db.rpc('task_complete', { p_task_id: t.id, p_expected_version: t.version })

    const { data } = await c.maria.db
      .from('tasks')
      .select('id')
      .eq('status', 'open')
      .lt('due_at', new Date().toISOString())
    expect((data ?? []).map((x) => x.id)).not.toContain(t.id)
  })
})

describe('nada de estado derivado persistido', () => {
  it('nao existe coluna overdue, today ou upcoming', async () => {
    for (const coluna of ['overdue', 'today', 'upcoming', 'is_overdue']) {
      const { error } = await c.admin.from('tasks').select(coluna).limit(1)
      // Coluna inexistente e o resultado CORRETO: atraso e uma pergunta feita
      // ao relogio na hora, nao um fato guardado que alguem teria de reescrever.
      expect(error, `coluna ${coluna} nao deveria existir`).not.toBeNull()
    }
  })

  it('a mesma pendencia muda de visao so pela passagem do tempo', async () => {
    const daquiA2s = new Date(Date.now() + 2000)
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Vence em dois segundos',
      dueAt: daquiA2s.toISOString(),
    })

    const antes = await c.maria.db
      .from('tasks')
      .select('id')
      .eq('id', t.id)
      .lt('due_at', new Date().toISOString())
    expect(antes.data ?? []).toHaveLength(0)

    await new Promise((r) => setTimeout(r, 2500))

    const depois = await c.maria.db
      .from('tasks')
      .select('id, version')
      .eq('id', t.id)
      .lt('due_at', new Date().toISOString())
    expect(depois.data ?? []).toHaveLength(1)
    // Virou atrasada sem que ninguem escrevesse nada: a versao nao mudou.
    expect((depois.data as { version: number }[])[0]!.version).toBe(1)
  })
})
