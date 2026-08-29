/**
 * Ausencia de N+1, medida — nao argumentada.
 *
 * A afirmacao "resolvemos o paciente com embed, entao nao ha N+1" e uma
 * alegacao sobre o PostgREST, e alegacao sobre software de terceiro envelhece.
 * Aqui contamos as consultas que o banco REALMENTE executou, via
 * `pg_stat_statements`, com uma pagina de 1 e outra de 50.
 *
 * O criterio nao e "poucas consultas": e que o numero NAO cresca com o tamanho
 * da pagina. Um N+1 de verdade some em cima de 1 item e aparece em cima de 50.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import type { Page, TaskListItem } from '@clinicas/shared'
import { montarCenario, novaTask, assumir, type Cenario } from './task-helpers'

let c: Cenario
let db: pg.Client

function conectar(uri: string): pg.Client {
  // Campos discretos em vez da URI: senha do Supabase costuma conter
  // caracteres reservados no userinfo, e o parser os normalizaria.
  const m = /^postgresql:\/\/([^:]+):(.*)@([^/]+)\/(.+)$/.exec(uri)
  if (!m) throw new Error('SUPABASE_DB_URL em formato inesperado.')
  const [, user, password, hostPort, database] = m
  const [host, port] = hostPort!.split(':')
  return new pg.Client({
    user: decodeURIComponent(user!),
    password: decodeURIComponent(password!),
    host,
    port: Number(port ?? 5432),
    database: database!.split('?')[0],
    ssl: { rejectUnauthorized: false },
  })
}

/**
 * Quantas execucoes de consulta tocaram as tabelas de interesse.
 *
 * `pg_stat_statements` normaliza por forma da consulta, entao `calls` cresce
 * uma unidade por EXECUCAO — que e exatamente a unidade que interessa aqui.
 */
async function chamadas(): Promise<number> {
  const { rows } = await db.query(
    `select coalesce(sum(calls), 0)::int as n
       from pg_stat_statements
      where query ilike '%tasks%'
         or query ilike '%task_events%'
         or query ilike '%clinic_member_directory%'`,
  )
  return rows[0].n as number
}

async function medir(fn: () => Promise<unknown>): Promise<number> {
  const antes = await chamadas()
  await fn()
  // Pequena folga: o coletor do pg_stat_statements atualiza ao fim da execucao.
  await new Promise((r) => setTimeout(r, 400))
  return (await chamadas()) - antes
}

beforeAll(async () => {
  c = await montarCenario()
  const uri = process.env.SUPABASE_DB_URL
  if (!uri) throw new Error('SUPABASE_DB_URL ausente: esta suite mede consultas reais.')
  db = conectar(uri)
  await db.connect()

  const saude = await fetch(`${c.env.apiUrl}/api/health`).catch(() => null)
  if (!saude?.ok) throw new Error(`API precisa estar no ar em ${c.env.apiUrl}.`)
}, 180_000)

afterAll(async () => {
  await c?.registry.cleanup(c.admin)
  await db?.end()
}, 120_000)

const buscar = async (qs: string) => {
  const r = await fetch(`${c.env.apiUrl}/api/tasks${qs}`, {
    headers: {
      Authorization: `Bearer ${c.maria.accessToken}`,
      'x-clinic-id': c.maria.clinicId,
    },
  })
  expect(r.status).toBe(200)
  return (await r.json()) as Page<TaskListItem>
}

describe('numero de consultas nao cresce com a pagina', () => {
  beforeAll(async () => {
    // 50 pendencias, todas COM paciente e COM responsavel: e o pior caso, o que
    // um N+1 ingenuo resolveria com uma consulta por linha.
    for (let n = 0; n < 50; n += 1) {
      const t = await novaTask(c.maria.db, c.maria.clinicId, {
        title: `Carga ${n}`,
        patientId: c.maria.patientId,
      })
      await assumir(c.maria.db, t)
    }
  }, 180_000)

  it('lista de 1 e lista de 25 custam o mesmo numero de consultas', async () => {
    /*
     * A comparacao usa `assignment=mine` nos DOIS lados de proposito.
     *
     * Com `due=any`, uma pagina de 1 item pode cair numa pendencia sem
     * responsavel — e ai o diretorio nao e buscado, dando 1 consulta contra 2.
     * A diferenca seria real, mas nao seria N+1: e uma otimizacao condicional.
     * Comparar duas paginas que ambas TEM responsavel isola a unica pergunta
     * que interessa aqui: o custo cresce com o tamanho da pagina?
     */
    await buscar('?assignment=mine&limit=1')
    await buscar('?assignment=mine&limit=25')

    const uma = await medir(async () => {
      const p = await buscar('?assignment=mine&limit=1')
      expect(p.items).toHaveLength(1)
      expect(p.items[0]!.assignee).not.toBeNull()
    })
    const muitas = await medir(async () => {
      const p = await buscar('?assignment=mine&limit=25')
      expect(p.items).toHaveLength(25)
      expect(p.items.every((i) => i.assignee !== null)).toBe(true)
      expect(p.items.every((i) => i.patient !== null)).toBe(true)
    })

    // Constante, nao "parecida": um N+1 daria ~26 contra ~2.
    expect(muitas).toBe(uma)
    // E o teto absoluto: a pagina e o diretorio de membros.
    expect(muitas).toBeLessThanOrEqual(2)
  })

  it('a lista de 50 tambem custa no maximo duas consultas', async () => {
    await buscar('?limit=50')
    const n = await medir(async () => {
      const p = await buscar('?limit=50')
      expect(p.items).toHaveLength(50)
      expect(p.items.every((i) => i.patient !== null)).toBe(true)
    })
    expect(n).toBeLessThanOrEqual(2)
  })

  it('o detalhe resolve os tres contextos sem consulta extra por contexto', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, {
      title: 'Detalhe com contexto',
      patientId: c.maria.patientId,
    })
    await assumir(c.maria.db, t)

    const chamar = async () => {
      const r = await fetch(`${c.env.apiUrl}/api/tasks/${t.id}`, {
        headers: {
          Authorization: `Bearer ${c.maria.accessToken}`,
          'x-clinic-id': c.maria.clinicId,
        },
      })
      expect(r.status).toBe(200)
    }
    await chamar()
    const n = await medir(chamar)

    // A pendencia (com paciente, conversa e agendamento embutidos) e o
    // diretorio para o nome do responsavel.
    expect(n).toBeLessThanOrEqual(2)
  })

  it('a lista sem nenhum responsavel dispensa o diretorio', async () => {
    // Fila geral: nao ha nome de responsavel para resolver, entao a segunda
    // consulta simplesmente nao acontece.
    await buscar('?assignment=unassigned&limit=20')
    const n = await medir(() => buscar('?assignment=unassigned&limit=20'))
    expect(n).toBe(1)
  })

  it('os eventos custam duas consultas: existencia e pagina', async () => {
    const t = await novaTask(c.maria.db, c.maria.clinicId, { title: 'Eventos medidos' })
    await assumir(c.maria.db, t)

    const chamar = async () => {
      const r = await fetch(`${c.env.apiUrl}/api/tasks/${t.id}/events`, {
        headers: {
          Authorization: `Bearer ${c.maria.accessToken}`,
          'x-clinic-id': c.maria.clinicId,
        },
      })
      expect(r.status).toBe(200)
    }
    await chamar()
    const n = await medir(chamar)
    expect(n).toBeLessThanOrEqual(2)
  })
})
