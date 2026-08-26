import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { PRODUCT_NAME } from './ui/brand'
import './globals.css'

export const metadata: Metadata = {
  /*
   * `template` deixa cada rota dizer so o proprio nome; a marca e concatenada
   * aqui. `default` cobre as telas internas, que nao declaram title proprio.
   */
  title: {
    default: `${PRODUCT_NAME} — sistema de agenda para clínicas`,
    template: `%s`,
  },
  description:
    'Agenda, pacientes, profissionais e serviços da clínica em um só sistema. ' +
    'Cada clínica com seus próprios dados, isolados no banco.',
  applicationName: PRODUCT_NAME,
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b1220',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
