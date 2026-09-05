'use client'

import { useEffect, useState } from 'react'
import type { ClinicMemberSummary } from '@clinicas/shared'
import { NovaPendencia } from '../pendencias/nova-pendencia'
import { IconPlus } from '../../ui/icons'

/**
 * Botao "Criar pendencia" na ficha do paciente.
 *
 * O paciente e sempre conhecido aqui — nao ha ficha sem paciente —, entao o
 * contexto so carrega patientId/patientName, sem conversationId nem
 * appointmentId. Mesmo formulario de /pendencias (NovaPendencia); nada
 * duplicado.
 */
export function PatientPendencia({
  patientId,
  patientName,
  equipe,
  timezone,
}: {
  patientId: string
  patientName: string
  equipe: ClinicMemberSummary[]
  timezone: string
}) {
  const [criando, setCriando] = useState(false)
  const [aviso, setAviso] = useState<string | null>(null)

  /** Some sozinho — mesmo padrao de Atendimento/Pendencias/Agenda. */
  useEffect(() => {
    if (!aviso) return
    const t = setTimeout(() => setAviso(null), 6000)
    return () => clearTimeout(t)
  }, [aviso])

  return (
    <>
      {aviso ? (
        <div className="pt-aviso" role="status">
          {aviso}
        </div>
      ) : null}

      <button type="button" className="btn secondary sm" onClick={() => setCriando(true)}>
        <IconPlus size={14} /> Criar pendência
      </button>

      {criando ? (
        <NovaPendencia
          equipe={equipe}
          timezone={timezone}
          contexto={{ patientId, patientName }}
          onFechar={() => setCriando(false)}
          onCriada={() => {
            // Fecha, avisa e fica na ficha do paciente — nunca navega para
            // /pendencias sozinho.
            setCriando(false)
            setAviso('Pendência criada.')
          }}
        />
      ) : null}
    </>
  )
}
