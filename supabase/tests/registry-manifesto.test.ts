/**
 * Ciclo de vida do manifesto de execucao.
 *
 * Roda contra um `admin` FALSO, de proposito: a pergunta e sobre a decisao de
 * apagar ou preservar o arquivo, e prova-la contra o Supabase real exigiria
 * provocar falhas de limpeza de verdade — sujeira no Dev para testar um `if`.
 *
 * O bug que estes testes trancam: o registry decidia pelo ERRO do DELETE, e nao
 * pelo estado final. Apagar uma conta que um teste ja tinha removido de
 * proposito devolvia "User not found", virava "limpeza incompleta", e o
 * manifesto ficava. Era assim que .runs/ acumulava — 15 arquivos de execucoes
 * que na verdade tinham terminado limpas.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MANIFEST_DIR, TestResourceRegistry } from './helpers'

const URL_FALSA = 'https://projeto-de-teste.supabase.co'

interface Estado {
  /** Clinicas que ainda existem depois das tentativas de remocao. */
  clinicasRemanescentes: string[]
  /** Usuarios que ainda existem. */
  usuariosRemanescentes: string[]
  /** Erro devolvido pelo DELETE de usuario, mesmo quando ele nao existe mais. */
  erroAoApagarUsuario?: { message: string; status?: number }
  /** Erro devolvido pelo DELETE de clinicas. */
  erroAoApagarClinica?: { message: string }
  /** Faz a VERIFICACAO falhar, e nao a remocao. */
  erroAoVerificarClinica?: { message: string }
}

/** Admin falso: so o suficiente para o registry conversar. */
function adminFalso(estado: Estado): SupabaseClient {
  return {
    from: () => ({
      delete: () => ({
        in: async () => ({ error: estado.erroAoApagarClinica ?? null }),
      }),
      select: () => ({
        in: async () => ({
          data: estado.erroAoVerificarClinica
            ? null
            : estado.clinicasRemanescentes.map((id) => ({ id })),
          error: estado.erroAoVerificarClinica ?? null,
        }),
      }),
    }),
    auth: {
      admin: {
        deleteUser: async () => ({ error: estado.erroAoApagarUsuario ?? null }),
        getUserById: async (id: string) =>
          estado.usuariosRemanescentes.includes(id)
            ? { data: { user: { id } }, error: null }
            : { data: { user: null }, error: { message: 'User not found', status: 404 } },
      },
    },
  } as unknown as SupabaseClient
}

function caminhoDo(registry: TestResourceRegistry): string {
  return join(MANIFEST_DIR, `${registry.testRunId}.json`)
}

const criados: TestResourceRegistry[] = []

function novoRegistry(): TestResourceRegistry {
  const r = new TestResourceRegistry(URL_FALSA)
  criados.push(r)
  return r
}

afterEach(async () => {
  // Nao deixa arquivo de teste para tras nem quando a asserção falha.
  const { rmSync } = await import('node:fs')
  for (const r of criados.splice(0)) rmSync(caminhoDo(r), { force: true })
  vi.restoreAllMocks()
})

describe('caminho feliz', () => {
  it('apaga o manifesto quando a verificacao confirma que nada sobrou', async () => {
    const r = novoRegistry()
    r.registerClinic('11111111-1111-4111-8111-111111111111')
    r.registerUser('22222222-2222-4222-8222-222222222222')
    expect(existsSync(caminhoDo(r))).toBe(true)

    await r.cleanup(
      adminFalso({ clinicasRemanescentes: [], usuariosRemanescentes: [] }),
    )

    expect(existsSync(caminhoDo(r))).toBe(false)
  })

  it('"User not found" no DELETE nao impede apagar o manifesto', async () => {
    // Este e literalmente o caso que enchia .runs/: o teste ja tinha apagado a
    // conta efemera de proposito, e o registry lia o erro como sobra.
    const r = novoRegistry()
    r.registerUser('33333333-3333-4333-8333-333333333333')
    const avisos = vi.spyOn(console, 'error').mockImplementation(() => {})

    await r.cleanup(
      adminFalso({
        clinicasRemanescentes: [],
        usuariosRemanescentes: [],
        erroAoApagarUsuario: { message: 'User not found', status: 404 },
      }),
    )

    expect(existsSync(caminhoDo(r))).toBe(false)
    expect(avisos).not.toHaveBeenCalled()
  })

  it('sem nenhum recurso registrado, tambem apaga', async () => {
    const r = novoRegistry()
    await r.cleanup(adminFalso({ clinicasRemanescentes: [], usuariosRemanescentes: [] }))
    expect(existsSync(caminhoDo(r))).toBe(false)
  })
})

describe('preservacao', () => {
  it('preserva quando a suite falhou, mesmo com a limpeza completa', async () => {
    const r = novoRegistry()
    r.registerClinic('44444444-4444-4444-8444-444444444444')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await r.cleanup(adminFalso({ clinicasRemanescentes: [], usuariosRemanescentes: [] }), {
      estadoIncerto: true,
    })

    // Teste que falhou pode ter criado recurso FORA do registry: o manifesto
    // fica como ponto de partida da investigacao.
    expect(existsSync(caminhoDo(r))).toBe(true)
  })

  it('preserva quando a clinica continua existindo', async () => {
    const r = novoRegistry()
    const clinica = '55555555-5555-4555-8555-555555555555'
    r.registerClinic(clinica)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await r.cleanup(
      adminFalso({
        clinicasRemanescentes: [clinica],
        usuariosRemanescentes: [],
        erroAoApagarClinica: { message: 'permission denied' },
      }),
    )

    expect(existsSync(caminhoDo(r))).toBe(true)
    const manifesto = JSON.parse(readFileSync(caminhoDo(r), 'utf8'))
    expect(manifesto.clinicIds).toEqual([clinica])
  })

  it('preserva na limpeza PARCIAL: clinica saiu, usuario ficou', async () => {
    const r = novoRegistry()
    const usuario = '66666666-6666-4666-8666-666666666666'
    r.registerClinic('77777777-7777-4777-8777-777777777777')
    r.registerUser(usuario)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await r.cleanup(
      adminFalso({ clinicasRemanescentes: [], usuariosRemanescentes: [usuario] }),
    )

    expect(existsSync(caminhoDo(r))).toBe(true)
  })

  it('preserva quando a VERIFICACAO falha: incerteza nao autoriza apagar', async () => {
    const r = novoRegistry()
    r.registerClinic('88888888-8888-4888-8888-888888888888')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // A remocao "deu certo", mas nao conseguimos confirmar. Apagar o manifesto
    // aqui destruiria a unica lista de IDs para a recuperacao manual.
    await r.cleanup(
      adminFalso({
        clinicasRemanescentes: [],
        usuariosRemanescentes: [],
        erroAoVerificarClinica: { message: 'connection reset' },
      }),
    )

    expect(existsSync(caminhoDo(r))).toBe(true)
  })

  it('avisa com o comando de recuperacao quando preserva', async () => {
    const r = novoRegistry()
    const usuario = '99999999-9999-4999-8999-999999999999'
    r.registerUser(usuario)
    const avisos = vi.spyOn(console, 'error').mockImplementation(() => {})

    await r.cleanup(
      adminFalso({ clinicasRemanescentes: [], usuariosRemanescentes: [usuario] }),
    )

    const mensagem = avisos.mock.calls.map((c) => String(c[0])).join('\n')
    expect(mensagem).toContain('PRESERVADO')
    expect(mensagem).toContain(r.testRunId)
    expect(mensagem).toContain('test:isolation:cleanup')
  })
})

describe('a limpeza e sempre por ID', () => {
  it('nunca emite filtro amplo: so `in` com a lista registrada', async () => {
    const r = novoRegistry()
    r.registerClinic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

    const chamadas: unknown[][] = []
    const admin = {
      from: () => ({
        delete: () => ({
          in: async (...args: unknown[]) => {
            chamadas.push(args)
            return { error: null }
          },
        }),
        select: () => ({ in: async () => ({ data: [], error: null }) }),
      }),
      auth: { admin: { deleteUser: async () => ({ error: null }), getUserById: async () => ({ data: { user: null }, error: { message: 'not found' } }) } },
    } as unknown as SupabaseClient

    await r.cleanup(admin)

    // `in('id', [...])` e nada mais: sem like, sem truncate, sem delete-where.
    expect(chamadas).toEqual([['id', ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']]])
  })
})
