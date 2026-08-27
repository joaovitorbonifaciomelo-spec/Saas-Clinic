/**
 * Executa a cadeia INTEIRA de migrations num Postgres efemero (PGlite, em
 * memoria) e afirma as garantias que so aparecem rodando SQL de verdade.
 *
 * POR QUE ISSO EXISTE
 *
 * Um `as $` no lugar de `as $$` passa por lint, por typecheck e por revisao de
 * diff — e so falha quando o Postgres tenta parsear. Aconteceu neste projeto,
 * causado por `String.replace` interpretando `$$` na string de substituicao
 * como um `$` literal. Nenhuma ferramenta de JavaScript enxerga esse tipo de
 * erro; um Postgres de verdade enxerga na primeira linha.
 *
 * O QUE ISSO NAO E
 *
 * Nao substitui os testes contra o Supabase. PGlite nao tem PostgREST, nem o
 * servidor de auth, nem a reconciliacao de privilegios da plataforma. O que ele
 * garante: a cadeia parseia, executa na ordem, e as constraints, triggers e
 * funcoes se comportam como escrito.
 *
 *   pnpm verify:migrations
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
// pgcrypto nao vem por padrao no PGlite; a fundacao o exige na 0001.
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(raiz, 'supabase', 'migrations')

let falhas = 0
let checagens = 0

function ok(nome, extra = '') {
  checagens += 1
  console.log(`  [32mOK[0m   ${nome}${extra ? ` — ${extra}` : ''}`)
}
function falhou(nome, detalhe) {
  falhas += 1
  checagens += 1
  console.log(`  [31mFALHA[0m ${nome}\n        ${detalhe}`)
}

async function afirma(nome, fn) {
  try {
    const r = await fn()
    if (r === false) falhou(nome, 'condicao falsa')
    else ok(nome, typeof r === 'string' ? r : '')
  } catch (e) {
    falhou(nome, e.message.split('\n')[0])
  }
}

/** Espera que a operacao FALHE, e opcionalmente com uma marca no erro. */
async function afirmaRecusa(nome, fn, marca) {
  try {
    await fn()
    falhou(nome, 'deveria ter sido recusado, mas passou')
  } catch (e) {
    const msg = `${e.message} ${e.code ?? ''}`
    if (marca && !msg.includes(marca)) {
      falhou(nome, `recusado por outro motivo: ${msg.split('\n')[0]}`)
    } else {
      ok(nome)
    }
  }
}

const db = new PGlite({ extensions: { pgcrypto } })

/** Roda como um usuario autenticado especifico, como o PostgREST faria. */
async function comoUsuario(userId, fn) {
  await db.exec('begin')
  // SET nao aceita parametro; set_config com is_local=true e o equivalente.
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId }),
  ])
  await db.exec('set local role authenticated')
  try {
    const r = await fn()
    await db.exec('commit')
    return r
  } catch (e) {
    await db.exec('rollback')
    throw e
  }
}

try {
  console.log('\n  === 1. Cadeia de migrations ===\n')

  await db.exec(readFileSync(join(raiz, 'supabase', 'local', 'shim.sql'), 'utf8'))
  ok('shim do Supabase aplicado')

  const arquivos = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const arquivo of arquivos) {
    const sql = readFileSync(join(migrationsDir, arquivo), 'utf8')
    try {
      await db.exec(sql)
      ok(arquivo)
    } catch (e) {
      falhou(arquivo, `${e.message.split('\n')[0]}`)
      // Sem esta migration, nada abaixo faz sentido.
      throw new Error(`migration ${arquivo} falhou; interrompendo`, { cause: e })
    }
  }

  // ---------------------------------------------------------------- cenario
  console.log('\n  === 2. Cenario de duas clinicas ===\n')

  const mk = async (rot) => {
    const { rows } = await db.query(
      `insert into auth.users (email, raw_user_meta_data)
       values ($1, $2) returning id`,
      [`${rot}@example.test`, JSON.stringify({ full_name: `Usuario ${rot}` })],
    )
    return rows[0].id
  }
  const userA = await mk('a')
  const userA2 = await mk('a2')
  const userB = await mk('b')

  const criarClinica = async (userId, nome) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(`select id from public.create_clinic_with_owner($1)`, [nome])
      return rows[0].id
    })

  const clinicA = await criarClinica(userA, 'Clinica A')
  const clinicB = await criarClinica(userB, 'Clinica B')
  await db.query(`insert into public.clinic_members (clinic_id, user_id, role) values ($1,$2,'attendant')`, [clinicA, userA2])
  ok('duas clinicas com membros')

  const inserirPaciente = (userId, clinicId, nome) =>
    comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.patients (clinic_id, name, phone) values ($1,$2,'11987650000')
         returning id`,
        [clinicId, nome],
      )
      return rows[0].id
    })
  const pacienteA = await inserirPaciente(userA, clinicA, 'Paciente A')
  const pacienteB = await inserirPaciente(userB, clinicB, 'Paciente B')

  const novaConversa = (userId, clinicId, extra = {}) =>
    comoUsuario(userId, async () => {
      const cols = ['clinic_id', 'channel', ...Object.keys(extra)]
      const vals = [clinicId, 'manual', ...Object.values(extra)]
      const ph = vals.map((_, i) => `$${i + 1}`).join(', ')
      const { rows } = await db.query(
        `insert into public.conversations (${cols.join(', ')}) values (${ph})
         returning id, version`,
        vals,
      )
      return rows[0]
    })

  const convA = await novaConversa(userA, clinicA)
  const convB = await novaConversa(userB, clinicB)
  ok('conversas criadas')

  // ------------------------------------------------- 3. evento automatico
  console.log('\n  === 3. Log de auditoria ===\n')

  await afirma('conversation_created e emitido automaticamente', async () => {
    const { rows } = await db.query(
      `select event_type, metadata from public.conversation_events where conversation_id = $1`,
      [convA.id],
    )
    if (rows.length !== 1) return false
    return rows[0].event_type === 'conversation_created' && rows[0].metadata.channel === 'manual'
  })

  await afirmaRecusa(
    'membro NAO consegue inserir evento a mao',
    () =>
      comoUsuario(userA, () =>
        db.query(
          `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
           values ($1, $2, 'transferred', '{}'::jsonb)`,
          [clinicA, convA.id],
        ),
      ),
    'permission denied',
  )

  await afirmaRecusa(
    'membro NAO consegue apagar evento',
    () =>
      comoUsuario(userA, () =>
        db.query(`delete from public.conversation_events where clinic_id = $1`, [clinicA]),
      ),
    'permission denied',
  )

  // ------------------------------------------------- 4. controle por RPC
  console.log('\n  === 4. Operacoes de controle ===\n')

  await afirmaRecusa(
    'UPDATE direto em conversations e negado',
    () =>
      comoUsuario(userA, () =>
        db.query(`update public.conversations set status = 'resolved' where id = $1`, [convA.id]),
      ),
    'permission denied',
  )

  const chamar = (userId, fn, args) =>
    comoUsuario(userId, async () => {
      const ph = args.map((_, i) => `$${i + 1}`).join(', ')
      const { rows } = await db.query(`select public.${fn}(${ph}) as r`, args)
      return rows[0].r
    })

  await afirma('assign com versao correta funciona', async () => {
    const r = await chamar(userA, 'conversation_assign', [convA.id, convA.version])
    return r.outcome === 'ok' && r.conversation.assignedTo === userA
  })

  await afirma('assign gera evento na mesma transacao', async () => {
    const { rows } = await db.query(
      `select count(*)::int as n from public.conversation_events
        where conversation_id = $1 and event_type = 'assigned'`,
      [convA.id],
    )
    return rows[0].n === 1
  })

  await afirma('assign com versao stale devolve conflito com o estado atual', async () => {
    const r = await chamar(userA2, 'conversation_assign', [convA.id, convA.version])
    return (
      r.outcome === 'conflict' &&
      r.conversation.assignedTo === userA &&
      r.conversation.version === convA.version + 1
    )
  })

  await afirma('conversa de outro tenant devolve not_found, nunca conflito', async () => {
    const r = await chamar(userA, 'conversation_assign', [convB.id, 1])
    return r.outcome === 'not_found' && r.conversation === undefined
  })

  await afirma('conversa inexistente devolve a MESMA resposta de outro tenant', async () => {
    const r = await chamar(userA, 'conversation_assign', [
      '00000000-0000-4000-8000-000000000000',
      1,
    ])
    return JSON.stringify(r) === JSON.stringify({ outcome: 'not_found' })
  })

  await afirma('dois assign concorrentes: so um vence', async () => {
    const c = await novaConversa(userA, clinicA)
    const r1 = await chamar(userA, 'conversation_assign', [c.id, c.version])
    const r2 = await chamar(userA2, 'conversation_assign', [c.id, c.version])
    const vencedores = [r1, r2].filter((r) => r.outcome === 'ok')
    return vencedores.length === 1
  })

  await afirma('transferir exige dono anterior', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await chamar(userA, 'conversation_transfer', [c.id, c.version, userA2])
    return r.outcome === 'conflict'
  })

  await afirma('status muda por RPC e registra from/to', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await chamar(userA, 'conversation_set_status', [c.id, c.version, 'resolved'])
    if (r.outcome !== 'ok' || r.conversation.status !== 'resolved') return false
    const { rows } = await db.query(
      `select metadata from public.conversation_events
        where conversation_id = $1 and event_type = 'status_changed'`,
      [c.id],
    )
    return rows.length === 1 && rows[0].metadata.from === 'open' && rows[0].metadata.to === 'resolved'
  })

  await afirma('transicao invalida aborta tudo, sem evento orfao', async () => {
    const c = await novaConversa(userA, clinicA)
    await chamar(userA, 'conversation_set_status', [c.id, c.version, 'resolved'])
    let recusado = false
    try {
      await chamar(userA, 'conversation_set_status', [c.id, c.version + 1, 'waiting_patient'])
    } catch (e) {
      recusado = e.message.includes('INVALID_STATUS_TRANSITION')
    }
    const { rows } = await db.query(
      `select count(*)::int as n from public.conversation_events
        where conversation_id = $1 and event_type = 'status_changed'`,
      [c.id],
    )
    // O evento da transicao recusada NAO pode existir; so o resolved anterior.
    return recusado && rows[0].n === 1
  })

  await afirma('vincular paciente da propria clinica funciona e registra', async () => {
    const c = await novaConversa(userA, clinicA)
    const r = await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteA])
    return r.outcome === 'ok' && r.conversation.patientId === pacienteA
  })

  await afirmaRecusa(
    'vincular paciente de OUTRA clinica e recusado pela FK composta',
    async () => {
      const c = await novaConversa(userA, clinicA)
      await chamar(userA, 'conversation_link_patient', [c.id, c.version, pacienteB])
    },
    '23503',
  )

  // ------------------------------------------------- 5. autoria de mensagem
  console.log('\n  === 5. Mensagens ===\n')

  await afirma('outbound NAO consegue forjar autoria', async () => {
    const c = await novaConversa(userA, clinicA)
    const { rows } = await comoUsuario(userA, () =>
      db.query(
        `insert into public.messages
           (clinic_id, conversation_id, channel, direction, body,
            author_user_id, author_name_snapshot)
         values ($1, $2, 'whatsapp', 'outbound', 'ola', $3, 'Nome Falso')
         returning author_user_id, author_name_snapshot, channel`,
        [clinicA, c.id, userB],
      ),
    )
    const m = rows[0]
    return (
      m.author_user_id === userA &&
      m.author_name_snapshot !== 'Nome Falso' &&
      m.channel === 'manual'
    )
  })

  await afirma('inbound nunca tem autor interno', async () => {
    const c = await novaConversa(userA, clinicA)
    const { rows } = await comoUsuario(userA, () =>
      db.query(
        `insert into public.messages (clinic_id, conversation_id, direction, body,
                                      author_user_id, author_name_snapshot)
         values ($1, $2, 'inbound', 'oi', $3, 'Falso')
         returning author_user_id, author_name_snapshot`,
        [clinicA, c.id, userA],
      ),
    )
    return rows[0].author_user_id === null && rows[0].author_name_snapshot === null
  })

  await afirma('inbound reabre conversa resolvida, com evento do sistema', async () => {
    const c = await novaConversa(userA, clinicA)
    await chamar(userA, 'conversation_set_status', [c.id, c.version, 'resolved'])
    await comoUsuario(userA, () =>
      db.query(
        `insert into public.messages (clinic_id, conversation_id, direction, body)
         values ($1, $2, 'inbound', 'voltei')`,
        [clinicA, c.id],
      ),
    )
    const { rows } = await db.query(`select status from public.conversations where id = $1`, [c.id])
    const ev = await db.query(
      `select actor_user_id, metadata from public.conversation_events
        where conversation_id = $1 and metadata->>'reason' = 'inbound_message'`,
      [c.id],
    )
    return rows[0].status === 'open' && ev.rows.length === 1 && ev.rows[0].actor_user_id === null
  })

  await afirma('mensagem NAO incrementa a versao da conversa', async () => {
    const c = await novaConversa(userA, clinicA)
    await comoUsuario(userA, () =>
      db.query(
        `insert into public.messages (clinic_id, conversation_id, direction, body)
         values ($1, $2, 'inbound', 'oi')`,
        [clinicA, c.id],
      ),
    )
    const { rows } = await db.query(`select version from public.conversations where id = $1`, [c.id])
    return rows[0].version === c.version
  })

  await afirma('mensagens manuais identicas podem repetir', async () => {
    const c = await novaConversa(userA, clinicA)
    for (let i = 0; i < 2; i += 1) {
      await comoUsuario(userA, () =>
        db.query(
          `insert into public.messages (clinic_id, conversation_id, direction, body)
           values ($1, $2, 'outbound', 'Confirmou por telefone.')`,
          [clinicA, c.id],
        ),
      )
    }
    const { rows } = await db.query(
      `select count(*)::int as n from public.messages where conversation_id = $1`,
      [c.id],
    )
    return rows[0].n === 2
  })

  // ------------------------------------------------- 6. identidade
  console.log('\n  === 6. Identidade da thread ===\n')

  await afirma('duas conversas manuais sem telefone coexistem', async () => {
    await novaConversa(userA, clinicA)
    await novaConversa(userA, clinicA)
    return true
  })

  await afirmaRecusa(
    'mesmo telefone na mesma clinica colide',
    async () => {
      await novaConversa(userA, clinicA, { contact_phone_e164: '+5511900000001' })
      await novaConversa(userA, clinicA, { contact_phone_e164: '+5511900000001' })
    },
    '23505',
  )

  await afirma('mesmo telefone em clinicas diferentes convive', async () => {
    await novaConversa(userA, clinicA, { contact_phone_e164: '+5511900000002' })
    await novaConversa(userB, clinicB, { contact_phone_e164: '+5511900000002' })
    return true
  })

  await afirma('sem telefone, o provedor faz parte da identidade', async () => {
    // Mesmo provider_contact_id, provedores diferentes: threads diferentes.
    await db.query(
      `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
       values ($1,'whatsapp','evolution','wa-1'), ($1,'whatsapp','meta_cloud','wa-1')`,
      [clinicA],
    )
    return true
  })

  await afirmaRecusa(
    'mesmo provedor + mesmo contato colide',
    () =>
      db.query(
        `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
         values ($1,'whatsapp','evolution','wa-1')`,
        [clinicA],
      ),
    '23505',
  )

  await afirmaRecusa(
    'canal manual nao aceita provedor',
    () =>
      db.query(
        `insert into public.conversations (clinic_id, channel, provider)
         values ($1,'manual','evolution')`,
        [clinicA],
      ),
    '23514',
  )

  await afirmaRecusa(
    'telefone fora de E.164 e recusado',
    () =>
      db.query(
        `insert into public.conversations (clinic_id, channel, contact_phone_e164)
         values ($1,'manual','11987654321')`,
        [clinicA],
      ),
    '23514',
  )

  await afirmaRecusa(
    'canal de uma conversa NAO pode mudar',
    () =>
      db.query(`update public.conversations set channel = 'whatsapp' where id = $1`, [convA.id]),
    'IDENTITY_IMMUTABLE',
  )

  await afirmaRecusa(
    'provider_contact_id definido NAO pode ser trocado',
    async () => {
      const { rows } = await db.query(
        `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
         values ($1,'whatsapp','evolution','wa-troca') returning id`,
        [clinicA],
      )
      await db.query(`update public.conversations set provider_contact_id = 'outro' where id = $1`, [
        rows[0].id,
      ])
    },
    'IDENTITY_IMMUTABLE',
  )

  await afirmaRecusa(
    'sem telefone, o provedor NAO pode ser trocado silenciosamente',
    async () => {
      const { rows } = await db.query(
        `insert into public.conversations (clinic_id, channel, provider, provider_contact_id)
         values ($1,'whatsapp','evolution','wa-prov') returning id`,
        [clinicA],
      )
      await db.query(`update public.conversations set provider = 'meta_cloud' where id = $1`, [
        rows[0].id,
      ])
    },
    'IDENTITY_IMMUTABLE',
  )

  await afirma('COM telefone, o provedor pode mudar (Evolution -> Meta)', async () => {
    const { rows } = await db.query(
      `insert into public.conversations
         (clinic_id, channel, provider, provider_contact_id, contact_phone_e164)
       values ($1,'whatsapp','evolution','wa-mig','+5511900000003') returning id`,
      [clinicA],
    )
    await db.query(`update public.conversations set provider = 'meta_cloud' where id = $1`, [
      rows[0].id,
    ])
    return true
  })

  await afirma('provider_contact_id nulo PODE ser preenchido depois', async () => {
    const { rows } = await db.query(
      `insert into public.conversations (clinic_id, channel, provider, contact_phone_e164)
       values ($1,'whatsapp','evolution','+5511900000004') returning id`,
      [clinicA],
    )
    await db.query(`update public.conversations set provider_contact_id = 'wa-novo' where id = $1`, [
      rows[0].id,
    ])
    return true
  })

  // ------------------------------------------------- 7. appointment_created
  console.log('\n  === 7. Proveniencia de agendamento ===\n')

  const criarAgendamento = async (userId, clinicId, pacienteId) => {
    const prof = await comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.professionals (clinic_id, name) values ($1,'Prof') returning id`,
        [clinicId],
      )
      return rows[0].id
    })
    return comoUsuario(userId, async () => {
      const { rows } = await db.query(
        `insert into public.appointments (clinic_id, patient_id, professional_id, starts_at, ends_at)
         values ($1,$2,$3, now() + interval '1 day', now() + interval '1 day 30 minutes')
         returning id`,
        [clinicId, pacienteId, prof],
      )
      return rows[0].id
    })
  }

  const apptA = await criarAgendamento(userA, clinicA, pacienteA)
  const apptB = await criarAgendamento(userB, clinicB, pacienteB)

  await afirma('appointment_created da propria clinica e aceito', async () => {
    const r = await chamar(userA, 'conversation_log_appointment', [convA.id, apptA])
    return r.outcome === 'ok'
  })

  await afirmaRecusa(
    'appointment_created cross-tenant e recusado (RPC)',
    () => chamar(userA, 'conversation_log_appointment', [convA.id, apptB]),
    'APPOINTMENT_NOT_IN_CLINIC',
  )

  await afirmaRecusa(
    'nem como DONO DA TABELA da para plantar agendamento de outra clinica',
    () =>
      db.query(
        `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
         values ($1, $2, 'appointment_created', jsonb_build_object('appointment_id', $3::text))`,
        [clinicA, convA.id, apptB],
      ),
    'APPOINTMENT_NOT_IN_CLINIC',
  )

  await afirmaRecusa(
    'metadata com chave extra e recusado',
    () =>
      db.query(
        `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
         values ($1, $2, 'appointment_created',
                 jsonb_build_object('appointment_id', $3::text, 'extra', 'x'))`,
        [clinicA, convA.id, apptA],
      ),
    '23514',
  )

  await afirmaRecusa(
    'metadata volumoso e recusado',
    () =>
      db.query(
        `insert into public.conversation_events (clinic_id, conversation_id, event_type, metadata)
         values ($1, $2, 'status_changed', jsonb_build_object('p', repeat('x', 4000)))`,
        [clinicA, convA.id],
      ),
    '23514',
  )

  // ------------------------------------------------- 8. isolamento e FK
  console.log('\n  === 8. Isolamento ===\n')

  await afirma('A so enxerga as conversas de A', async () => {
    const n = await comoUsuario(userA, async () => {
      const { rows } = await db.query(
        `select count(*)::int as n from public.conversations where clinic_id = $1`,
        [clinicB],
      )
      return rows[0].n
    })
    return n === 0
  })

  await afirmaRecusa(
    'nem o dono da tabela atribui conversa a membro de outra clinica',
    () => db.query(`update public.conversations set assigned_to = $1 where id = $2`, [userB, convA.id]),
    '23503',
  )

  await afirma('remover membership devolve a conversa a fila sem bloquear', async () => {
    const c = await novaConversa(userA, clinicA)
    await chamar(userA2, 'conversation_assign', [c.id, c.version])
    await db.query(`delete from public.clinic_members where clinic_id = $1 and user_id = $2`, [
      clinicA,
      userA2,
    ])
    const { rows } = await db.query(`select assigned_to from public.conversations where id = $1`, [
      c.id,
    ])
    const ev = await db.query(
      `select actor_name_snapshot from public.conversation_events
        where conversation_id = $1 and event_type = 'assigned'`,
      [c.id],
    )
    // Conversa livre, e a autoria historica preservada pelo snapshot.
    return rows[0].assigned_to === null && ev.rows[0].actor_name_snapshot !== null
  })
} catch (e) {
  falhou('execucao', e.message)
} finally {
  await db.close()
}

console.log(
  `\n  ${checagens} checagens, ${falhas} falha(s)\n`,
)
process.exit(falhas === 0 ? 0 : 1)
