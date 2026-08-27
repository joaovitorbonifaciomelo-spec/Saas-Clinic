import type { Service } from '@clinicas/shared'
import { apiFetch } from '../../../../lib/api'
import { loadForActiveClinic } from '../../../session'
import { PerfMeta } from '../../../ui/perf-meta'
import { ServicesManager } from './services-manager'

export const dynamic = 'force-dynamic'

export default async function ServicesPage() {
  // Uma onda: /api/me e a lista de servicos saem juntos.
  const { data: services } = await loadForActiveClinic((clinicId) =>
    apiFetch<Service[]>('/api/services', { clinicId }),
  )

  return (
    <>
      <ServicesManager services={services} />
      <PerfMeta />
    </>
  )
}
