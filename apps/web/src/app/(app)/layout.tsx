import type { ReactNode } from 'react'
import { getActiveSession } from '../session'
import { Sidebar } from '../ui/sidebar'
import { Topbar } from '../ui/topbar'

/**
 * Shell das telas internas.
 *
 * Route group `(app)`: agrupa sem entrar na URL, entao /dashboard, /patients e
 * /agenda continuam nos mesmos enderecos. Login, signup e onboarding ficam de
 * fora do grupo e seguem sem shell — quem ainda nao tem clinica nao tem o que
 * navegar.
 *
 * `getActiveSession` e memoizado por requisicao (React cache), entao layout e
 * pagina compartilham a MESMA chamada a /api/me. Sem isso, colocar o nome da
 * clinica na topbar custaria uma ida e volta extra (~250ms) em toda navegacao.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { profile, activeClinic } = await getActiveSession()

  return (
    <div className="shell">
      <Sidebar
        userName={profile.fullName}
        role={activeClinic.role}
        clinicName={activeClinic.clinicName}
      />
      <div className="main">
        <Topbar
          clinicName={activeClinic.clinicName}
          userName={profile.fullName}
          role={activeClinic.role}
        />
        {children}
      </div>
    </div>
  )
}
