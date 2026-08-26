import Link from 'next/link'
import { getActiveSession } from '../../../session'
import { createPatientAction } from '../patient-actions'
import { PatientForm } from '../patient-form'

export const dynamic = 'force-dynamic'

export default async function NewPatientPage() {
  await getActiveSession()

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
