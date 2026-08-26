import type { Metadata } from 'next'
import { AuthSplit } from '../ui/auth-split'
import { PRODUCT_NAME } from '../ui/brand'
import { LoginForm } from './login-form'

export const metadata: Metadata = {
  title: `Entrar — ${PRODUCT_NAME}`,
  description: 'Acesse o sistema de agenda, pacientes e profissionais da sua clínica.',
  robots: { index: false },
}

export default function LoginPage() {
  return (
    <AuthSplit
      headline="O sistema que a recepção usa o dia"
      accent="inteiro."
      description="Agenda, pacientes, profissionais e serviços da clínica em um só lugar."
    >
      <LoginForm />
    </AuthSplit>
  )
}
