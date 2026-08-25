import Link from 'next/link'
import { requireActiveSession } from '../../session'
import { createPatientAction } from '../patient-actions'
import { PatientForm } from '../patient-form'

export const dynamic = 'force-dynamic'

export default async function NewPatientPage() {
  await requireActiveSession()

  return (
    <main className="container narrow">
      <h1>Novo paciente</h1>
      <PatientForm action={createPatientAction} submitLabel="Salvar" />
      <p>
        <Link href="/patients">Voltar</Link>
      </p>
    </main>
  )
}
