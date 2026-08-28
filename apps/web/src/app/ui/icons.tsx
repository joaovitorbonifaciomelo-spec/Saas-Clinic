/**
 * Icones como SVG inline.
 *
 * Sem biblioteca: sao poucos icones e uma dependencia inteira custaria peso de
 * bundle e mais uma superficie de versao para manter. Todos herdam `currentColor`
 * e o traco de 1.6 combina com a espessura das bordas da interface.
 */
interface IconProps {
  size?: number
  className?: string
}

function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  }
}

export const IconToday = ({ size = 17, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
  </svg>
)

export const IconCalendar = ({ size = 17, className }: IconProps) => (
  <svg {...base(size, className)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
)

export const IconUsers = ({ size = 17, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
    <circle cx="9" cy="7.5" r="3.5" />
    <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
    <path d="M16.5 4.13a4 4 0 0 1 0 7.75" />
  </svg>
)

export const IconStethoscope = ({ size = 17, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M6 3v5a4 4 0 0 0 8 0V3" />
    <path d="M6 3H4.5M14 3h1.5" />
    <path d="M10 12v2a5 5 0 0 0 5 5 4 4 0 0 0 4-4v-1" />
    <circle cx="19" cy="11" r="2" />
  </svg>
)

export const IconTag = ({ size = 17, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 12.5V5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.41.59l6.5 6.5a2 2 0 0 1 0 2.82l-7.5 7.5a2 2 0 0 1-2.82 0l-6.5-6.5A2 2 0 0 1 3 12.5Z" />
    <circle cx="8" cy="8" r="1.4" />
  </svg>
)

export const IconSearch = ({ size = 15, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

export const IconPlus = ({ size = 15, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconChevronLeft = ({ size = 16, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="m14 6-6 6 6 6" />
  </svg>
)

export const IconChevronRight = ({ size = 16, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="m10 6 6 6-6 6" />
  </svg>
)

export const IconClock = ({ size = 16, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const IconCheck = ({ size = 16, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </svg>
)

export const IconRefresh = ({ size = 16, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20 11a8 8 0 0 0-13.6-4.6L3 9" />
    <path d="M3 4v5h5" />
    <path d="M4 13a8 8 0 0 0 13.6 4.6L21 15" />
    <path d="M21 20v-5h-5" />
  </svg>
)

export const IconPhone = ({ size = 15, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5L16 12l4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3 6.2 2 2 0 0 1 5 4Z" />
  </svg>
)

export const IconCake = ({ size = 15, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M4 20h16v-5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2Z" />
    <path d="M12 11V8M9 8V6.5M15 8V6.5M12 4.5V3.5" />
  </svg>
)

export const IconShield = ({ size = 15, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 3 5 6v5.5c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6Z" />
  </svg>
)

export const IconEdit = ({ size = 15, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17Z" />
    <path d="m14.5 6.5 3 3" />
  </svg>
)

export const IconLogout = ({ size = 16, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    <path d="M10 16 6 12l4-4M6 12h10" />
  </svg>
)

export const IconAlert = ({ size = 16, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 4 3 19h18Z" />
    <path d="M12 10v4M12 16.5v.5" />
  </svg>
)

export const IconCross = ({ size = 18, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
    className={className}
  >
    <path d="M9.6 3h4.8v5.6H20v4.8h-5.6V19H9.6v-5.6H4V8.6h5.6Z" />
  </svg>
)

/** Caixa de atendimento. Balao de conversa, nao logo de aplicativo nenhum. */
export const IconInbox = ({ size = 17, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-4 3v-3H4.5A2.5 2.5 0 0 1 2 14.5v-8A2.5 2.5 0 0 1 4.5 4h13A2.5 2.5 0 0 1 20 6.5Z" />
    <path d="M7 9h8M7 12.5h5" />
  </svg>
)
