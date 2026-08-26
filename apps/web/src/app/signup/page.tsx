import type { Metadata } from 'next'
import { AuthSplit } from '../ui/auth-split'
import { PRODUCT_NAME } from '../ui/brand'
import { SignUpForm } from './signup-form'

export const metadata: Metadata = {
  title: `Criar conta — ${PRODUCT_NAME}`,
  description: 'Crie sua conta e comece a organizar a agenda, os pacientes e os profissionais.',
  robots: { index: false },
}

export default function SignUpPage() {
  return (
    <AuthSplit
      headline="Comece pela agenda da"
      accent="sua clínica."
      description="Cadastre profissionais, serviços e horários e monte a semana em poucos minutos."
    >
      <SignUpForm />
    </AuthSplit>
  )
}
