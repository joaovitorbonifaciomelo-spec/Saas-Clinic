import Link from 'next/link'
import type { Service } from '@clinicas/shared'
import { apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'
import { ServicesManager } from './services-manager'

export const dynamic = 'force-dynamic'

export default async function ServicesPage() {
  const { activeClinic } = await requireActiveSession()
  const services = await apiFetch<Service[]>('/api/services', {
    clinicId: activeClinic.clinicId,
  })

  return (
    <main className="container">
      <div className="row">
        <h1>Servicos</h1>
        <Link href="/agenda">Voltar para a agenda</Link>
      </div>
      <ServicesManager services={services} />
    </main>
  )
}
