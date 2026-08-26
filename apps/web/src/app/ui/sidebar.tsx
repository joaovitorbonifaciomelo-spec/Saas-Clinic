'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { IconCalendar, IconCross, IconStethoscope, IconTag, IconToday, IconUsers } from './icons'
import { initials } from './format'

/**
 * Navegacao lateral.
 *
 * Contem SOMENTE modulos que existem. Nada de WhatsApp, Financeiro, Relatorios
 * ou Automacoes: item de menu que nao leva a lugar nenhum e promessa quebrada
 * toda vez que alguem clica.
 */
const OPERACAO = [
  { href: '/dashboard', label: 'Hoje', Icon: IconToday },
  { href: '/agenda', label: 'Agenda', Icon: IconCalendar },
  { href: '/patients', label: 'Pacientes', Icon: IconUsers },
] as const

const GESTAO = [
  { href: '/agenda/professionals', label: 'Profissionais', Icon: IconStethoscope },
  { href: '/agenda/services', label: 'Serviços', Icon: IconTag },
] as const

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador',
  attendant: 'Recepção',
  professional: 'Profissional',
}

export function Sidebar({
  userName,
  role,
  clinicName,
}: {
  userName: string
  role: string
  clinicName: string
}) {
  const pathname = usePathname()

  /*
   * /agenda/professionals nao pode acender "Agenda" junto. Prefixo simples
   * marcaria os dois, entao o item mais especifico ganha por comparacao exata,
   * e /agenda so aceita prefixo quando nenhum item de gestao casa.
   */
  const isGestao = GESTAO.some((item) => pathname.startsWith(item.href))
  const isActive = (href: string) =>
    href === pathname || (!isGestao && href !== '/dashboard' && pathname.startsWith(`${href}/`))

  return (
    <nav className="sidebar" aria-label="Navegação principal">
      <div className="brand">
        <span className="brand-mark">
          <IconCross size={17} />
        </span>
        <span>{clinicName}</span>
      </div>

      <div className="nav-section">
        {OPERACAO.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className="nav-item"
            aria-current={isActive(href) ? 'page' : undefined}
          >
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </div>

      <div className="nav-heading">Gestão</div>
      <div className="nav-section">
        {GESTAO.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            className="nav-item"
            aria-current={pathname.startsWith(href) ? 'page' : undefined}
          >
            <Icon />
            <span>{label}</span>
          </Link>
        ))}
      </div>

      <div className="sidebar-foot">
        <div className="nav-user">
          <span className="avatar sm nav">{initials(userName)}</span>
          <div>
            <div className="nav-user-name">{userName}</div>
            <div className="nav-user-role">{ROLE_LABEL[role] ?? role}</div>
          </div>
        </div>
      </div>
    </nav>
  )
}
