'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import type { ConversationDetail } from '@clinicas/shared'
import {
  carregarPacientesAction,
  desvincularPacienteAction,
  vincularPacienteAction,
  type ResultadoControle,
} from './atendimento-actions'
import { formatPhone, initials } from '../../ui/format'
import { IconPhone, IconPlus, IconSearch } from '../../ui/icons'
import { hora } from './at-format'

interface PacienteBusca {
  id: string
  name: string
  phone: string
}

/**
 * Contexto do paciente.
 *
 * No desktop e a terceira coluna; em telas menores entra como gaveta. O
 * conteudo e o mesmo — o que muda e onde ele aparece, nao o que ele diz.
 */
export function PainelContexto({
  conversa,
  timezone,
  aberto,
  onFechar,
  onAviso,
}: {
  conversa: ConversationDetail | null
  timezone: string
  aberto: boolean
  onFechar: () => void
  onAviso: (texto: string) => void
}) {
  const [pendente, startTransition] = useTransition()
  const [buscando, setBuscando] = useState(false)
  const [termo, setTermo] = useState('')
  const [pacientes, setPacientes] = useState<PacienteBusca[] | null>(null)

  useEffect(() => {
    if (!buscando || pacientes !== null) return
    // Reusa a API de Pacientes que ja existe. Nao ha endpoint novo.
    carregarPacientesAction()
      .then(setPacientes)
      .catch(() => setPacientes([]))
  }, [buscando, pacientes])

  if (!conversa) {
    return <aside className={`card at-contexto ${aberto ? 'is-aberto' : ''}`} aria-hidden="true" />
  }

  const c = conversa

  function aplicar(r: ResultadoControle): void {
    if (r.ok) {
      setBuscando(false)
      setTermo('')
      return
    }
    if (r.motivo === 'conflito') {
      onAviso(
        'Outra pessoa alterou este atendimento enquanto você estava nele. Atualizamos as informações.',
      )
      return
    }
    /*
     * Vinculo ja existente NAO vira troca automatica. A mensagem da API ja diz
     * o que fazer — desvincular antes —, e repassa-la e melhor do que inventar
     * um atalho que faria unlink+link escondido.
     */
    onAviso(r.mensagem)
  }

  const filtrados = (pacientes ?? []).filter((p) => {
    const t = termo.trim().toLowerCase()
    if (!t) return true
    const digitos = t.replace(/\D/g, '')
    return p.name.toLowerCase().includes(t) || (digitos.length >= 3 && p.phone.includes(digitos))
  })

  return (
    <aside className={`card at-contexto ${aberto ? 'is-aberto' : ''}`}>
      <div className="at-contexto-head">
        <h3>Paciente</h3>
        <button type="button" className="btn ghost sm at-fechar-contexto" onClick={onFechar}>
          Fechar
        </button>
      </div>

      {c.patient ? (
        <>
          <div className="at-paciente">
            <span className="avatar lg">{initials(c.patient.name)}</span>
            <div style={{ minWidth: 0 }}>
              <div className="at-paciente-nome">{c.patient.name}</div>
              <div className="faint tabular">
                <IconPhone /> {formatPhone(c.patient.phone)}
              </div>
            </div>
          </div>

          <div className="at-contexto-bloco">
            <p className="label">Próxima consulta</p>
            {c.nextAppointment ? (
              <div className="at-proxima">
                <div className="at-proxima-quando tabular">
                  {new Intl.DateTimeFormat('pt-BR', {
                    timeZone: timezone,
                    day: '2-digit',
                    month: 'short',
                  }).format(new Date(c.nextAppointment.startsAt))}{' '}
                  às {hora(c.nextAppointment.startsAt, timezone)}
                </div>
                <div className="faint">
                  {c.nextAppointment.professionalName ?? 'Profissional não informado'}
                  {c.nextAppointment.serviceName ? ` · ${c.nextAppointment.serviceName}` : ''}
                </div>
              </div>
            ) : (
              <p className="faint">Sem consulta futura agendada.</p>
            )}
          </div>

          <div className="at-contexto-acoes">
            <Link href={`/patients?p=${c.patient.id}`} prefetch={false} className="btn secondary sm">
              Ver paciente
            </Link>
            {/* Reusa a Agenda existente, com o paciente pre-selecionado. Nao ha
                API nova e nao criamos vinculo Conversation-Appointment. */}
            <Link
              href={`/agenda?novo=1&patient=${c.patient.id}`}
              prefetch={false}
              className="btn secondary sm"
            >
              <IconPlus size={14} /> Novo agendamento
            </Link>
            <button
              type="button"
              className="btn ghost sm"
              disabled={pendente}
              onClick={() =>
                startTransition(async () => {
                  aplicar(await desvincularPacienteAction(c.id, c.version))
                })
              }
            >
              Desvincular paciente
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="at-sem-paciente">
            <p className="at-sem-paciente-titulo">Paciente não identificado</p>
            <div className="at-contexto-bloco">
              <p className="label">Contato</p>
              <p>{c.contactNameSnapshot ?? 'Nome não informado'}</p>
              <p className="faint tabular">
                {c.contactPhoneE164
                  ? formatPhone(c.contactPhoneE164.replace(/^\+55/, ''))
                  : 'Telefone não informado'}
              </p>
            </div>
          </div>

          {!buscando ? (
            <div className="at-contexto-acoes">
              <button type="button" className="btn sm" onClick={() => setBuscando(true)}>
                Vincular paciente existente
              </button>
              {/* Criar paciente e do modulo de Pacientes. Depois de criado, a
                  pessoa volta e vincula — explicitamente. */}
              <Link href="/patients/new" prefetch={false} className="btn secondary sm">
                <IconPlus size={14} /> Criar novo paciente
              </Link>
            </div>
          ) : (
            <div className="at-vincular">
              <div className="search inline">
                <IconSearch />
                <input
                  type="search"
                  value={termo}
                  onChange={(e) => setTermo(e.target.value)}
                  placeholder="Buscar paciente"
                  aria-label="Buscar paciente para vincular"
                  autoFocus
                />
              </div>

              {pacientes === null ? (
                <p className="faint">Carregando pacientes…</p>
              ) : filtrados.length === 0 ? (
                <p className="faint">Nenhum paciente encontrado.</p>
              ) : (
                <ul className="at-pacientes">
                  {filtrados.slice(0, 20).map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="at-paciente-item"
                        disabled={pendente}
                        onClick={() =>
                          startTransition(async () => {
                            aplicar(await vincularPacienteAction(c.id, c.version, p.id))
                          })
                        }
                      >
                        <span className="avatar sm">{initials(p.name)}</span>
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span className="master-name">{p.name}</span>
                          <span className="faint tabular">{formatPhone(p.phone)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <button
                type="button"
                className="btn ghost sm"
                onClick={() => {
                  setBuscando(false)
                  setTermo('')
                }}
              >
                Cancelar
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  )
}
