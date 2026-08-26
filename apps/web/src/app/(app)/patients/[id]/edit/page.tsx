import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Patient } from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../../../lib/api'
import { getActiveSession } from '../../../../session'
import { updatePatientAction } from '../../patient-actions'
import { PatientForm } from '../../patient-form'

export const dynamic = 'force-dynamic'

export default async function EditPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { activeClinic } = await getActiveSession()

  let patient: Patient
  try {
    patient = await apiFetch<Patient>(`/api/patients/${id}`, { clinicId: activeClinic.clinicId })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }

  const action = updatePatientAction.bind(null, patient.id)

  return (
    <main className="container narrow">
      <h1>Editar paciente</h1>
      <PatientForm action={action} patient={patient} submitLabel="Salvar alteracoes" />
      <p>
        <Link href={`/patients?p=${patient.id}`}>Voltar</Link>
      </p>
    </main>
  )
}
