import Link from 'next/link'
import { requireActiveSession } from '../session'
import { signOutAction } from '../auth-actions'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const { profile, activeClinic } = await requireActiveSession()

  return (
    <main className="container">
      <div className="row">
        <h1>{activeClinic.clinicName}</h1>
        <form action={signOutAction}>
          <button type="submit" className="secondary">
            Sair
          </button>
        </form>
      </div>

      <div className="card">
        <p>
          <strong>Usuario:</strong> {profile.fullName}
        </p>
        <p>
          <strong>E-mail:</strong> {profile.email}
        </p>
        <p>
          <strong>Papel:</strong> {activeClinic.role}
        </p>
      </div>

      <p>
        <Link href="/patients">Pacientes</Link>
      </p>
    </main>
  )
}
