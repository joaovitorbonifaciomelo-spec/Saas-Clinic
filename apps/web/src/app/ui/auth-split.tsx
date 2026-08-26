import type { ReactNode } from 'react'
import Link from 'next/link'
import { PRODUCT_NAME, Wordmark } from './brand'
import { IconCalendar, IconCross, IconStethoscope, IconTag, IconUsers } from './icons'

/*
 * Shell das telas de acesso: painel navy a esquerda, formulario a direita.
 *
 * O painel usa composicao grafica do proprio design system, nao foto de banco de
 * imagem: uma recepcao generica de stock diria menos sobre o produto do que a
 * lista do que ele realmente faz — e ainda custaria centenas de KB.
 *
 * No mobile o painel inteiro sai. Quem abriu /login as 7h50 com o telefone na
 * mao quer o campo de senha, nao a lista de beneficios.
 */

const BENEFICIOS = [
  {
    Icon: IconCalendar,
    titulo: 'Agenda por dia e semana',
    texto: 'Grade com uma coluna por profissional, conflitos e encaixes à vista.',
  },
  {
    Icon: IconUsers,
    titulo: 'Pacientes e histórico',
    texto: 'Ficha, próxima consulta e todos os agendamentos anteriores no mesmo lugar.',
  },
  {
    Icon: IconStethoscope,
    titulo: 'Profissionais e horários',
    texto: 'Faixas de atendimento por dia da semana, usadas pela agenda.',
  },
  {
    Icon: IconTag,
    titulo: 'Serviços e duração',
    texto: 'O término do agendamento sai da duração do serviço, sem conta na cabeça.',
  },
] as const

export function AuthSplit({
  headline,
  accent,
  description,
  children,
}: {
  headline: string
  accent: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="auth-split">
      <aside className="auth-panel">
        <div className="auth-panel-inner">
          <Link href="/" className="auth-panel-brand" aria-label={`${PRODUCT_NAME} — início`}>
            <Wordmark size="lg" tone="dark" />
          </Link>

          <div className="auth-panel-body">
            <p className="auth-panel-h">
              {headline} <span className="accent">{accent}</span>
            </p>
            <p className="auth-panel-lead">{description}</p>

            <ul className="auth-benefits">
              {BENEFICIOS.map(({ Icon, titulo, texto }) => (
                <li key={titulo}>
                  <span className="auth-benefit-icon">
                    <Icon size={17} />
                  </span>
                  <div>
                    <strong>{titulo}</strong>
                    <span>{texto}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Marca d'agua decorativa: aria-hidden porque nao carrega informacao. */}
        <span className="auth-panel-mark" aria-hidden>
          <IconCross size={430} />
        </span>
      </aside>

      <main className="auth-main">
        <div className="auth-mobile-brand">
          <Link href="/" aria-label={`${PRODUCT_NAME} — início`}>
            <Wordmark />
          </Link>
        </div>
        {children}
      </main>
    </div>
  )
}
