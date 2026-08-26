'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { WEEKDAY_LABELS, type AvailabilityBlock, type Professional } from '@clinicas/shared'
import {
  saveAvailabilityAction,
  saveProfessionalAction,
  type AgendaActionState,
} from '../agenda-actions'

const initialState: AgendaActionState = { error: null }

interface ProfessionalsManagerProps {
  professionals: Professional[]
  availabilityByProfessional: Record<string, AvailabilityBlock[]>
}

export function ProfessionalsManager(props: ProfessionalsManagerProps) {
  const router = useRouter()
  const [editing, setEditing] = useState<Professional | null | 'new'>(null)
  const [availabilityFor, setAvailabilityFor] = useState<Professional | null>(null)

  return (
    <>
      <div className="row">
        <p className="muted">{props.professionals.length} profissional(is)</p>
        <button type="button" onClick={() => setEditing('new')}>
          Novo profissional
        </button>
      </div>

      <div className="card">
        {props.professionals.length === 0 ? (
          <p className="muted">Nenhum profissional cadastrado.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Especialidade</th>
                <th>Situacao</th>
                <th>Horarios</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {props.professionals.map((professional) => {
                const blocks = props.availabilityByProfessional[professional.id] ?? []
                return (
                  <tr key={professional.id}>
                    <td>{professional.name}</td>
                    <td>{professional.specialty ?? '—'}</td>
                    <td>{professional.active ? 'Ativo' : 'Inativo'}</td>
                    <td>{blocks.length === 0 ? '—' : `${blocks.length} faixa(s)`}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setEditing(professional)}
                      >
                        Editar
                      </button>{' '}
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setAvailabilityFor(professional)}
                      >
                        Horarios
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

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
    </>
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
        <div className="row">
          <h2>{professional ? 'Editar profissional' : 'Novo profissional'}</h2>
          <button type="button" className="secondary" onClick={onClose}>
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
            <input type="text" name="specialty" defaultValue={professional?.specialty ?? ''} />
          </label>
          <label className="inline">
            <input type="checkbox" name="active" defaultChecked={professional?.active ?? true} />
            Ativo
          </label>
          {state.error ? <p className="error">{state.error}</p> : null}
          <button type="submit" disabled={pending}>
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
      startTime: block.startTime.slice(0, 5),
      endTime: block.endTime.slice(0, 5),
    })),
  )

  useEffect(() => {
    if (state.ok) onSaved()
    // Observar apenas state.ok e proposital.
  }, [state.ok])

  function update(index: number, patch: Partial<DraftBlock>): void {
    setDraft((current) => current.map((block, i) => (i === index ? { ...block, ...patch } : block)))
  }

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Horarios">
      <div className="drawer">
        <div className="row">
          <h2>Horarios de {professional.name}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            Fechar
          </button>
        </div>

        <p className="muted">
          Varias faixas por dia sao permitidas — por exemplo manha e tarde separadas pelo almoco.
        </p>

        <form action={formAction}>
          {/* A grade inteira e substituida numa transacao no servidor. */}
          <input type="hidden" name="blocks" value={JSON.stringify(draft)} />

          {draft.length === 0 ? <p className="muted">Nenhuma faixa configurada.</p> : null}

          {draft.map((block, index) => (
            <div key={index} className="field-row">
              <label>
                Dia
                <select
                  value={block.weekday}
                  onChange={(event) => update(index, { weekday: Number(event.target.value) })}
                >
                  {WEEKDAY_LABELS.map((label, weekday) => (
                    <option key={weekday} value={weekday}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Inicio
                <input
                  type="time"
                  value={block.startTime}
                  onChange={(event) => update(index, { startTime: event.target.value })}
                />
              </label>
              <label>
                Fim
                <input
                  type="time"
                  value={block.endTime}
                  onChange={(event) => update(index, { endTime: event.target.value })}
                />
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                aria-label="Remover faixa"
              >
                Remover
              </button>
            </div>
          ))}

          <button
            type="button"
            className="secondary"
            onClick={() =>
              setDraft((current) => [
                ...current,
                { weekday: 1, startTime: '08:00', endTime: '12:00' },
              ])
            }
          >
            + Adicionar faixa
          </button>

          {state.error ? <p className="error">{state.error}</p> : null}

          <button type="submit" disabled={pending}>
            {pending ? 'Salvando…' : 'Salvar horarios'}
          </button>
        </form>
      </div>
    </div>
  )
}
