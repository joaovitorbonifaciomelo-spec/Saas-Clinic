'use client'

import { useEffect, useState } from 'react'
import { carregarPacientesAction, criarConversaAction } from './atendimento-actions'
import { formatPhone } from '../../ui/format'

/**
 * Novo atendimento manual.
 *
 * O formulario tem TRES campos e nenhum de controle: canal, provedor, status,
 * versao e responsavel sao decididos pelo servidor. A API recusa qualquer um
 * deles com 400, entao nem existe caminho para mandar por engano.
 */
export function NovoAtendimento({
  onFechar,
  onCriada,
}: {
  onFechar: () => void
  onCriada: (conversationId: string, criada: boolean) => void
}) {
  const [nome, setNome] = useState('')
  const [telefone, setTelefone] = useState('')
  const [pacienteId, setPacienteId] = useState('')
  const [pacientes, setPacientes] = useState<{ id: string; name: string; phone: string }[]>([])
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    carregarPacientesAction()
      .then(setPacientes)
      .catch(() => setPacientes([]))
  }, [])

  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFechar()
    }
    window.addEventListener('keydown', aoTeclar)
    return () => window.removeEventListener('keydown', aoTeclar)
  }, [onFechar])

  async function salvar(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (salvando) return
    setSalvando(true)
    setErro(null)

    const r = await criarConversaAction({
      contactName: nome,
      contactPhone: telefone,
      patientId: pacienteId === '' ? null : pacienteId,
    })
    setSalvando(false)

    if (r.ok && r.conversationId) {
      // `criada: false` significa que o telefone ja tinha thread. Nao e erro:
      // abrimos a existente e avisamos discretamente.
      onCriada(r.conversationId, r.criada === true)
    } else {
      setErro(r.mensagem ?? 'Não foi possível criar o atendimento.')
    }
  }

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        // So o fundo fecha; clique dentro do painel nao deve descartar o que a
        // pessoa ja digitou.
        if (e.target === e.currentTarget) onFechar()
      }}
    >
      <div className="drawer at-drawer" role="dialog" aria-modal="true" aria-label="Novo atendimento">
        <div className="drawer-head">
          <h2>Novo atendimento</h2>
          <button type="button" className="btn ghost sm" onClick={onFechar}>
            Fechar
          </button>
        </div>

        <form className="at-form" onSubmit={salvar}>
          <p className="at-form-nota">
            Registra um atendimento que aconteceu por telefone, no balcão ou por outro canal fora
            do sistema. Nada é enviado ao paciente.
          </p>

          <label>
            <span className="label">Nome do contato</span>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              maxLength={120}
              placeholder="Como a pessoa se identificou"
              autoFocus
            />
          </label>

          <label>
            <span className="label">Telefone</span>
            <input
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              inputMode="tel"
              placeholder="(11) 98765-4321"
            />
            <span className="faint at-form-dica">
              Número brasileiro. O sistema normaliza ao salvar.
            </span>
          </label>

          <label>
            <span className="label">Paciente (opcional)</span>
            <select value={pacienteId} onChange={(e) => setPacienteId(e.target.value)}>
              <option value="">Não identificado</option>
              {pacientes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {formatPhone(p.phone)}
                </option>
              ))}
            </select>
          </label>

          {erro ? <p className="error">{erro}</p> : null}

          <div className="at-form-pe">
            <button type="button" className="btn secondary sm" onClick={onFechar}>
              Cancelar
            </button>
            <button type="submit" className="btn sm" disabled={salvando}>
              {salvando ? 'Criando…' : 'Criar atendimento'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
