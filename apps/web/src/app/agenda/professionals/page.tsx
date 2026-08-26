import Link from 'next/link'
import type { AvailabilityBlock, Professional } from '@clinicas/shared'
import { apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'
import { ProfessionalsManager } from './professionals-manager'

export const dynamic = 'force-dynamic'

export default async function ProfessionalsPage() {
  const { activeClinic } = await requireActiveSession()
  const clinicId = activeClinic.clinicId

  const professionals = await apiFetch<Professional[]>('/api/professionals', { clinicId })

  // A grade de cada profissional vem junto para a tela editar sem ida e volta.
  const availability = await Promise.all(
    professionals.map((professional) =>
      apiFetch<AvailabilityBlock[]>(`/api/professionals/${professional.id}/availability`, {
        clinicId,
      }).then((blocks) => [professional.id, blocks] as const),
    ),
  )

  return (
    <main className="container">
      <div className="row">
        <h1>Profissionais</h1>
        <Link href="/agenda">Voltar para a agenda</Link>
      </div>

      <ProfessionalsManager
        professionals={professionals}
        availabilityByProfessional={Object.fromEntries(availability)}
      />
    </main>
  )
}
