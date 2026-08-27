'use client'

import { useMemo, useOptimistic, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Patient } from '@clinicas/shared'
import { formatPhone, initials } from '../../ui/format'
import { IconPlus, IconSearch } from '../../ui/icons'

/**
 * Coluna mestre.
 *
 * A busca filtra no cliente, sobre a lista que ja veio. Nao ha endpoint de
 * busca no backend, e criar um estava fora do escopo deste checkpoint — filtrar
 * o que ja esta em memoria da resposta instantanea e nao inventa API.
 *
 * Limite conhecido: quando a clinica passar de algumas centenas de pacientes,
 * isso vira busca paginada no servidor. Anotado no relatorio.
 */
export function PatientList({
  patients,
  selectedId,
  query,
}: {
  patients: Patient[]
  selectedId?: string
  query: string
}) {
  const router = useRouter()
  const [q, setQ] = useState(query)

  /*
   * Trocar de paciente muda so a query string, entao o servidor re-renderiza a
   * rota e o realce demorava a ida e volta inteira para sair do lugar — o mesmo
   * clique morto medido no seletor Dia/Semana.
   *
   * O realce passa para o item clicado na hora; a ficha a direita continua
   * mostrando o paciente anterior ate a nova chegar, marcada como ocupada.
   */
  const [pendente, startTransition] = useTransition()
  const [selecionado, setSelecionado] = useOptimistic(selectedId)

  function abrir(id: string): void {
    startTransition(() => {
      setSelecionado(id)
      router.push(`/patients?p=${id}`, { scroll: false })
    })
  }

  const filtrados = useMemo(() => {
    const termo = q.trim().toLowerCase()
    if (!termo) return patients
    const digitos = termo.replace(/\D/g, '')
    return patients.filter(
      (p) =>
        p.name.toLowerCase().includes(termo) ||
        (digitos.length >= 3 && p.phone.includes(digitos)) ||
        (p.insuranceProvider ?? '').toLowerCase().includes(termo),
    )
  }, [patients, q])

  return (
    <aside className="card master">
      <div className="master-head">
        <div className="search inline">
          <IconSearch />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            /* Curto de proposito: o campo tem ~300px e o texto longo era cortado
               no meio da palavra. O que a busca cobre esta no title. */
            placeholder="Buscar paciente"
            title="Busca por nome, telefone ou convênio"
            aria-label="Buscar pacientes"
          />
        </div>
      </div>

      {/*
        O botao ficava ao lado da busca como um "+" sozinho, sem dizer o que
        criava. Aqui ele tem nome, divide a faixa com a contagem e nao rouba
        largura do campo de busca.
      */}
      <div className="master-meta">
        <span className="label">
          {q ? `${filtrados.length} de ${patients.length}` : `${patients.length} pacientes`}
        </span>
        {/* prefetch off: rota force-dynamic, o prefetch renderiza a pagina
            inteira no servidor sem ninguem ter pedido. */}
        <Link href="/patients/new" prefetch={false} className="btn sm">
          <IconPlus size={14} /> Novo paciente
        </Link>
      </div>

      <ul className="master-list" data-pendente={pendente ? 'sim' : undefined}>
        {filtrados.length === 0 ? (
          <li className="empty">Nenhum paciente encontrado.</li>
        ) : (
          filtrados.map((p) => (
            <li key={p.id}>
              {/*
                Continua sendo <a> de verdade: abre em nova aba, tem endereco
                proprio e funciona sem JavaScript. O onClick so antecipa o
                realce; a navegacao em si e a mesma.
              */}
              <Link
                href={`/patients?p=${p.id}`}
                scroll={false}
                prefetch={false}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                  event.preventDefault()
                  abrir(p.id)
                }}
                className={`master-item ${p.id === selecionado ? 'is-selected' : ''}`}
                aria-current={p.id === selecionado ? 'true' : undefined}
              >
                <span className="avatar sm">{initials(p.name)}</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="master-name">{p.name}</span>
                  <span className="faint tabular">{formatPhone(p.phone)}</span>
                </span>
                {p.insuranceProvider ? (
                  <span className="badge plain conv">{p.insuranceProvider}</span>
                ) : null}
              </Link>
            </li>
          ))
        )}
      </ul>
    </aside>
  )
}
