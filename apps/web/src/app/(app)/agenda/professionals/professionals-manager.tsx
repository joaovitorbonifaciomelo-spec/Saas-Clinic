'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { WEEKDAY_LABELS, type AvailabilityBlock, type Professional } from '@clinicas/shared'
import { initials } from '../../../ui/format'
import { IconClock, IconEdit, IconPlus } from '../../../ui/icons'
import {
  saveAvailabilityAction,
  saveProfessionalAction,
  type AgendaActionState,
} from '../agenda-actions'

const initialState: AgendaActionState = { error: null }

/** Iniciais dos dias na ordem do domingo, como o resto do produto. */
const DIA_INICIAL = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'] as const

function hhmm(time: string): string {
  return time.slice(0, 5)
}

/** Minutos somados das faixas — resume a carga semanal em um numero. */
function totalMinutos(blocks: AvailabilityBlock[]): number {
  return blocks.reduce((acc, b) => {
    const [hi, mi] = hhmm(b.startTime).split(':').map(Number)
    const [hf, mf] = hhmm(b.endTime).split(':').map(Number)
    return acc + (hf! * 60 + mf! - (hi! * 60 + mi!))
  }, 0)
}

function horasLabel(minutos: number): string {
  if (minutos <= 0) return '—'
  return `${Math.floor(minutos / 60)}h${minutos % 60 ? String(minutos % 60).padStart(2, '0') : ''}`
}

interface ProfessionalsManagerProps {
  professionals: Professional[]
  availabilityByProfessional: Record<string, AvailabilityBlock[]>
}

export function ProfessionalsManager(props: ProfessionalsManagerProps) {
  const router = useRouter()
  const [editing, setEditing] = useState<Professional | null | 'new'>(null)
  const [availabilityFor, setAvailabilityFor] = useState<Professional | null>(null)

  const ativos = props.professionals.filter((p) => p.active).length

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Profissionais</h1>
          <p className="page-sub">
            {props.professionals.length}{' '}
            {props.professionals.length === 1 ? 'cadastrado' : 'cadastrados'}
            {props.professionals.length > 0 ? ` · ${ativos} ${ativos === 1 ? 'ativo' : 'ativos'}` : ''}
          </p>
        </div>
        <button type="button" onClick={() => setEditing('new')}>
          <IconPlus /> Novo profissional
        </button>
      </div>

      <section className="card">
        {props.professionals.length === 0 ? (
          <p className="empty">
            Nenhum profissional cadastrado ainda.
            <br />
            Cadastre o primeiro para que a agenda tenha colunas.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Especialidade</th>
                  <th>Situação</th>
                  <th>Disponibilidade</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {props.professionals.map((professional) => {
                  const blocks = props.availabilityByProfessional[professional.id] ?? []
                  const ativosPorDia = new Set(blocks.filter((b) => b.active).map((b) => b.weekday))
                  const minutos = totalMinutos(blocks.filter((b) => b.active))

                  return (
                    <tr key={professional.id}>
                      <td>
                        <span className="cell-person">
                          <span className="avatar sm">{initials(professional.name)}</span>
                          {professional.name}
                        </span>
                      </td>
                      <td className="muted">{professional.specialty ?? '—'}</td>
                      <td>
                        <span className={`badge ${professional.active ? 'ok' : 'off'}`}>
                          {professional.active ? 'Ativo' : 'Inativo'}
                        </span>
                      </td>
                      <td>
                        {ativosPorDia.size === 0 ? (
                          <span className="faint">Sem horários</span>
                        ) : (
                          <span className="cell-avail">
                            {/*
                              Sete letras dizem QUAIS dias. "5 faixas" nao dizia,
                              e quem monta escala precisa exatamente disso.
                            */}
                            <span className="wk-chips" aria-hidden>
                              {DIA_INICIAL.map((letra, weekday) => (
                                <span
                                  key={weekday}
                                  className={`wk-chip ${ativosPorDia.has(weekday) ? 'on' : ''}`}
                                >
                                  {letra}
                                </span>
                              ))}
                            </span>
                            <span className="faint tabular">{horasLabel(minutos)}/sem</span>
                            <span className="sr-only">
                              Atende{' '}
                              {[...ativosPorDia]
                                .sort()
                                .map((d) => WEEKDAY_LABELS[d])
                                .join(', ')}
                            </span>
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="cell-actions">
                          <button
                            type="button"
                            className="secondary sm"
                            onClick={() => setAvailabilityFor(professional)}
                          >
                            <IconClock size={14} /> Horários
                          </button>
                          <button
                            type="button"
                            className="secondary sm"
                            onClick={() => setEditing(professional)}
                          >
                            <IconEdit /> Editar
                          </button>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing ? (
        <ProfessionalForm
          professional={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            router.refresh()
          }}
        />
      ) : null}

      {availabilityFor ? (
        <AvailabilityForm
          professional={availabilityFor}
          blocks={props.availabilityByProfessional[availabilityFor.id] ?? []}
          onClose={() => setAvailabilityFor(null)}
          onSaved={() => {
            setAvailabilityFor(null)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function ProfessionalForm({
  professional,
  onClose,
  onSaved,
}: {
  professional: Professional | null
  onClose: () => void
  onSaved: () => void
}) {
  const action = saveProfessionalAction.bind(null, professional?.id ?? null)
  const [state, formAction, pending] = useActionState(action, initialState)

  useEffect(() => {
    if (state.ok) onSaved()
    // Observar apenas state.ok e proposital.
  }, [state.ok])

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Profissional">
      <div className="drawer">
        <div className="drawer-head">
          <h2>{professional ? 'Editar profissional' : 'Novo profissional'}</h2>
          <button type="button" className="secondary sm" onClick={onClose}>
            Fechar
          </button>
        </div>

        <form action={formAction}>
          <label>
            Nome
            <input type="text" name="name" required defaultValue={professional?.name ?? ''} />
          </label>
          <label>
            Especialidade
            <input
              type="text"
              name="specialty"
              placeholder="Opcional"
              defaultValue={professional?.specialty ?? ''}
            />
          </label>
          <label className="inline">
            <input type="checkbox" name="active" defaultChecked={professional?.active ?? true} />
            Ativo na agenda
          </label>

          {state.error ? (
            <p className="error" role="alert">
              {state.error}
            </p>
          ) : null}

          <button type="submit" className="block" disabled={pending}>
            {pending ? 'Salvando…' : 'Salvar'}
          </button>
        </form>
      </div>
    </div>
  )
}

interface DraftBlock {
  weekday: number
  startTime: string
  endTime: string
}

function AvailabilityForm({
  professional,
  blocks,
  onClose,
  onSaved,
}: {
  professional: Professional
  blocks: AvailabilityBlock[]
  onClose: () => void
  onSaved: () => void
}) {
  const action = saveAvailabilityAction.bind(null, professional.id)
  const [state, formAction, pending] = useActionState(action, initialState)
  const [draft, setDraft] = useState<DraftBlock[]>(
    blocks.map((block) => ({
      weekday: block.weekday,
      startTime: hhmm(block.startTime),
      endTime: hhmm(block.endTime),
    })),
  )

  useEffect(() => {
    if (state.ok) onSaved()
    // Observar apenas state.ok e proposital.
  }, [state.ok])

  function update(index: number, patch: Partial<DraftBlock>): void {
    setDraft((current) => current.map((block, i) => (i === index ? { ...block, ...patch } : block)))
  }

  /*
   * Agrupado por dia so na APRESENTACAO. O que vai para o servidor continua
   * sendo a lista plana de `draft`, na mesma ordem, e a grade inteira continua
   * sendo substituida numa transacao. Nenhuma regra mudou aqui.
   */
  const porDia = useMemo(() => {
    const mapa = new Map<number, { block: DraftBlock; index: number }[]>()
    draft.forEach((block, index) => {
      const lista = mapa.get(block.weekday) ?? []
      lista.push({ block, index })
      mapa.set(block.weekday, lista)
    })
    return mapa
  }, [draft])

  const total = totalMinutos(
    draft.map((b) => ({ startTime: b.startTime, endTime: b.endTime }) as AvailabilityBlock),
  )

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Horários">
      <div className="drawer">
        <div className="drawer-head">
          <h2>Horários de {professional.name}</h2>
          <button type="button" className="secondary sm" onClick={onClose}>
            Fechar
          </button>
        </div>

        <p className="muted">
          Várias faixas por dia são permitidas — por exemplo manhã e tarde separadas pelo almoço.
        </p>

        <form action={formAction}>
          {/* A grade inteira e substituida numa transacao no servidor. */}
          <input type="hidden" name="blocks" value={JSON.stringify(draft)} />

          {draft.length === 0 ? (
            <p className="empty">Nenhuma faixa configurada.</p>
          ) : (
            <div className="avail-days">
              {WEEKDAY_LABELS.map((label, weekday) => {
                const doDia = porDia.get(weekday) ?? []
                if (doDia.length === 0) return null
                return (
                  <div key={weekday} className="avail-day">
                    <span className="label">{label}</span>
                    {doDia.map(({ block, index }) => (
                      <div key={index} className="avail-row">
                        <input
                          type="time"
                          value={block.startTime}
                          aria-label={`Início da faixa em ${label}`}
                          onChange={(event) => update(index, { startTime: event.target.value })}
                        />
                        <span className="faint">até</span>
                        <input
                          type="time"
                          value={block.endTime}
                          aria-label={`Fim da faixa em ${label}`}
                          onChange={(event) => update(index, { endTime: event.target.value })}
                        />
                        <select
                          value={block.weekday}
                          aria-label="Dia da semana"
                          onChange={(event) =>
                            update(index, { weekday: Number(event.target.value) })
                          }
                        >
                          {WEEKDAY_LABELS.map((dia, w) => (
                            <option key={w} value={w}>
                              {dia}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="ghost sm"
                          onClick={() =>
                            setDraft((current) => current.filter((_, i) => i !== index))
                          }
                          aria-label={`Remover faixa de ${label}`}
                          title="Remover faixa"
                        >
                          Remover
                        </button>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          )}

          <div className="avail-foot">
            <button
              type="button"
              className="secondary sm"
              onClick={() =>
                setDraft((current) => [
                  ...current,
                  { weekday: 1, startTime: '08:00', endTime: '12:00' },
                ])
              }
            >
              <IconPlus size={14} /> Adicionar faixa
            </button>
            <span className="faint tabular">{horasLabel(total)} por semana</span>
          </div>

          {state.error ? (
            <p className="error" role="alert">
              {state.error}
            </p>
          ) : null}

          <button type="submit" className="block" disabled={pending}>
            {pending ? 'Salvando…' : 'Salvar horários'}
          </button>
        </form>
      </div>
    </div>
  )
}
