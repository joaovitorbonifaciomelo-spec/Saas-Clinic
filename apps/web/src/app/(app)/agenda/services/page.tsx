import type { Service } from '@clinicas/shared'
import { apiFetch } from '../../../../lib/api'
import { getActiveSession } from '../../../session'
import { ServicesManager } from './services-manager'

export const dynamic = 'force-dynamic'

export default async function ServicesPage() {
  const { activeClinic } = await getActiveSession()
  const services = await apiFetch<Service[]>('/api/services', {
    clinicId: activeClinic.clinicId,
  })

  return <ServicesManager services={services} />
}
