import type { AvailabilityBlock, Professional } from '@clinicas/shared'
import { apiFetch } from '../../../../lib/api'
import { getActiveSession } from '../../../session'
import { ProfessionalsManager } from './professionals-manager'

export const dynamic = 'force-dynamic'

export default async function ProfessionalsPage() {
  const { activeClinic } = await getActiveSession()
  const clinicId = activeClinic.clinicId

  /*
   * Duas chamadas em paralelo, nao 1 + N em serie.
   *
   * A grade vinha de um GET por profissional, disparado DEPOIS de saber quem
   * eram os profissionais: tres ondas sequenciais (me -> profissionais ->
   * disponibilidades) e 2+N requisicoes. Como cada ida e volta pelo Funnel tem
   * mediana de 246ms e p90 de 853ms, cada onda a mais nao custa a mediana —
   * custa outra chance de cair na cauda.
   *
   * `/api/professionals/availability` devolve a grade da clinica inteira e ja
   * existia (a agenda usa desde o checkpoint 1). O agrupamento por profissional,
   * que era o unico motivo do laco, sai de graca aqui.
   */
  const [professionals, availability] = await Promise.all([
    apiFetch<Professional[]>('/api/professionals', { clinicId }),
    apiFetch<AvailabilityBlock[]>('/api/professionals/availability', { clinicId }).catch(
      () => [] as AvailabilityBlock[],
    ),
  ])

  const availabilityByProfessional: Record<string, AvailabilityBlock[]> = {}
  for (const professional of professionals) availabilityByProfessional[professional.id] = []
  for (const block of availability) {
    availabilityByProfessional[block.professionalId]?.push(block)
  }

  return (
    <ProfessionalsManager
      professionals={professionals}
      availabilityByProfessional={availabilityByProfessional}
    />
  )
}
