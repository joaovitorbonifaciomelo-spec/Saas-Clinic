import type { AvailabilityBlock, Professional } from '@clinicas/shared'
import { apiFetch } from '../../../../lib/api'
import { getActiveSession } from '../../../session'
import { ProfessionalsManager } from './professionals-manager'

export const dynamic = 'force-dynamic'

export default async function ProfessionalsPage() {
  const { activeClinic } = await getActiveSession()
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
    <ProfessionalsManager
      professionals={professionals}
      availabilityByProfessional={Object.fromEntries(availability)}
    />
  )
}
