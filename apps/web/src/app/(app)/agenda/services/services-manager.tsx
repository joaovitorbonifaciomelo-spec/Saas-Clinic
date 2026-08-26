'use client'

import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Service } from '@clinicas/shared'
import { saveServiceAction, type AgendaActionState } from '../agenda-actions'

const initialState: AgendaActionState = { error: null }

function formatPrice(priceCents: number | null): string {
  if (priceCents === null) return '—'
  return (priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function ServicesManager({ services }: { services: Service[] }) {
  const router = useRouter()
  const [editing, setEditing] = useState<Service | null | 'new'>(null)

  return (
    <>
      <div className="row">
        <p className="muted">{services.length} servico(s)</p>
        <button type="button" onClick={() => setEditing('new')}>
          Novo servico
        </button>
      </div>

      <div className="card">
        {services.length === 0 ? (
          <p className="muted">Nenhum servico cadastrado.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Duracao</th>
                <th>Preco</th>
                <th>Situacao</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {services.map((service) => (
                <tr key={service.id}>
                  <td>{service.name}</td>
                  <td>{service.durationMinutes} min</td>
                  <td>{formatPrice(service.priceCents)}</td>
                  <td>{service.active ? 'Ativo' : 'Inativo'}</td>
                  <td>
                    <button type="button" className="secondary" onClick={() => setEditing(service)}>
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
    </>
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
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Servico">
      <div className="drawer">
        <div className="row">
          <h2>{service ? 'Editar servico' : 'Novo servico'}</h2>
          <button type="button" className="secondary" onClick={onClose}>
            Fechar
          </button>
        </div>
        <form action={formAction}>
          <label>
            Nome
            <input type="text" name="name" required defaultValue={service?.name ?? ''} />
          </label>
          <label>
            Duracao (minutos)
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
            Preco em reais (opcional)
            <input
              type="number"
              name="priceReais"
              min={0}
              step="0.01"
              defaultValue={
                service?.priceCents !== null && service !== null ? service.priceCents / 100 : ''
              }
            />
          </label>
          <label className="inline">
            <input type="checkbox" name="active" defaultChecked={service?.active ?? true} />
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
