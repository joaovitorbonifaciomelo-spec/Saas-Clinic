import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Patient } from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'

export const dynamic = 'force-dynamic'

export default async function PatientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { activeClinic } = await requireActiveSession()

  let patient: Patient
  try {
    patient = await apiFetch<Patient>(`/api/patients/${id}`, { clinicId: activeClinic.clinicId })
  } catch (error) {
    // Paciente inexistente e paciente de outra clinica chegam aqui do mesmo
    // jeito (404 da API) e produzem a mesma tela. Nao revelamos a diferenca.
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }

  return (
    <main className="container narrow">
      <h1>{patient.name}</h1>
      <div className="card">
        <p>
          <strong>Telefone:</strong> {patient.phone}
        </p>
        <p>
          <strong>Nascimento:</strong> {patient.birthDate ?? '—'}
        </p>
        <p>
          <strong>Convenio:</strong> {patient.insuranceProvider ?? '—'}
        </p>
      </div>
      <div className="row">
        <Link href={`/patients/${patient.id}/edit`}>
          <button type="button">Editar</button>
        </Link>
        <Link href="/patients">Voltar</Link>
      </div>
    </main>
  )
}
