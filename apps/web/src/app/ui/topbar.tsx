import { signOutAction } from '../auth-actions'
import { IconLogout, IconSearch } from './icons'
import { initials } from './format'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrador',
  attendant: 'Recepção',
  professional: 'Profissional',
}

export function Topbar({
  clinicName,
  userName,
  role,
}: {
  clinicName: string
  userName: string
  role: string
}) {
  return (
    <header className="topbar">
      <span className="topbar-title">{clinicName}</span>

      {/*
        Busca ainda NAO existe no backend. Fica como campo desabilitado e
        rotulado "em breve" em vez de um input que aceita texto e nao faz nada —
        um campo que engole o que a pessoa digitou e pior que campo nenhum.
      */}
      <div className="topbar-spacer" />
      <div className="search" aria-hidden title="Busca global ainda não disponível">
        <IconSearch />
        <span>Buscar (em breve)</span>
        <kbd>⌘K</kbd>
      </div>
      <div className="topbar-spacer" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="avatar sm">{initials(userName)}</span>
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontSize: 13, fontWeight: 550 }}>{userName}</div>
          <div className="faint">{ROLE_LABEL[role] ?? role}</div>
        </div>
        <form action={signOutAction}>
          <button type="submit" className="ghost" title="Sair" aria-label="Sair">
            <IconLogout />
          </button>
        </form>
      </div>
    </header>
  )
}
