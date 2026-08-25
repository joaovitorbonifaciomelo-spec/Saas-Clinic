import Link from 'next/link'
import type { Patient } from '@clinicas/shared'
import { apiFetch } from '../../lib/api'
import { requireActiveSession } from '../session'

export const dynamic = 'force-dynamic'

export default async function PatientsPage() {
  const { activeClinic } = await requireActiveSession()
  const patients = await apiFetch<Patient[]>('/api/patients', {
    clinicId: activeClinic.clinicId,
  })

  return (
    <main className="container">
      <div className="row">
        <h1>Pacientes</h1>
        <Link href="/patients/new">
          <button type="button">Adicionar</button>
        </Link>
      </div>
      <p className="muted">
        Clinica: {activeClinic.clinicName} — {patients.length} paciente(s)
      </p>

      <div className="card">
        {patients.length === 0 ? (
          <p className="muted">Nenhum paciente cadastrado.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Telefone</th>
                <th>Convenio</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {patients.map((patient) => (
                <tr key={patient.id}>
                  <td>{patient.name}</td>
                  <td>{patient.phone}</td>
                  <td>{patient.insuranceProvider ?? '—'}</td>
                  <td>
                    <Link href={`/patients/${patient.id}`}>Ver</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p>
        <Link href="/dashboard">Voltar</Link>
      </p>
    </main>
  )
}
