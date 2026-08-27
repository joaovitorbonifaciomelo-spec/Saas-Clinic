'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Service } from '@clinicas/shared'
import { IconEdit, IconPlus } from '../../../ui/icons'
import { saveServiceAction, type AgendaActionState } from '../agenda-actions'

const initialState: AgendaActionState = { error: null }

function formatPrice(priceCents: number | null): string {
  if (priceCents === null) return '—'
  return (priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** 90 -> "1h30". Minuto puro fica ilegivel acima de uma hora. */
function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`
}

export function ServicesManager({ services }: { services: Service[] }) {
  const router = useRouter()
  const [editing, setEditing] = useState<Service | null | 'new'>(null)

  const ativos = services.filter((s) => s.active).length

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Serviços</h1>
          <p className="page-sub">
            {services.length} {services.length === 1 ? 'cadastrado' : 'cadastrados'}
            {services.length > 0 ? ` · ${ativos} ${ativos === 1 ? 'ativo' : 'ativos'}` : ''}
          </p>
        </div>
        <button type="button" onClick={() => setEditing('new')}>
          <IconPlus /> Novo serviço
        </button>
      </div>

      <section className="card">
        {services.length === 0 ? (
          <p className="empty">
            Nenhum serviço cadastrado ainda.
            <br />A duração do serviço é o que calcula o término de cada agendamento.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th className="num">Duração</th>
                  <th className="num">Preço</th>
                  <th>Situação</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id}>
                    <td style={{ fontWeight: 550 }}>{service.name}</td>
                    <td className="num">{formatDuration(service.durationMinutes)}</td>
                    <td className={`num ${service.priceCents === null ? 'faint' : ''}`}>
                      {formatPrice(service.priceCents)}
                    </td>
                    <td>
                      <span className={`badge ${service.active ? 'ok' : 'off'}`}>
                        {service.active ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td>
                      <span className="cell-actions">
                        <button
                          type="button"
                          className="secondary sm"
                          onClick={() => setEditing(service)}
                        >
                          <IconEdit /> Editar
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing ? (
        <ServiceForm
          service={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function ServiceForm({
  service,
  onClose,
  onSaved,
}: {
  service: Service | null
  onClose: () => void
  onSaved: () => void
}) {
  const action = saveServiceAction.bind(null, service?.id ?? null)
  const [state, formAction, pending] = useActionState(action, initialState)

  useEffect(() => {
    if (state.ok) onSaved()
    // Observar apenas state.ok e proposital.
  }, [state.ok])

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Serviço">
      <div className="drawer">
        <div className="drawer-head">
          <h2>{service ? 'Editar serviço' : 'Novo serviço'}</h2>
          <button type="button" className="secondary sm" onClick={onClose}>
            Fechar
          </button>
        </div>

        <form action={formAction}>
          <label>
            Nome
            <input type="text" name="name" required defaultValue={service?.name ?? ''} />
          </label>

          <div className="field-row">
            <label>
              Duração (minutos)
              <input
                type="number"
                name="durationMinutes"
                required
                min={1}
                max={480}
                defaultValue={service?.durationMinutes ?? 30}
              />
            </label>
            <label>
              Preço em reais
              <input
                type="number"
                name="priceReais"
                min={0}
                step="0.01"
                placeholder="Opcional"
                defaultValue={
                  service?.priceCents !== null && service !== null ? service.priceCents / 100 : ''
                }
              />
            </label>
          </div>

          <label className="inline">
            <input type="checkbox" name="active" defaultChecked={service?.active ?? true} />
            Disponível para agendamento
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
