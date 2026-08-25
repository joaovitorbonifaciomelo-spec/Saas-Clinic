'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { signUpAction, type ActionState } from '../auth-actions'

const initialState: ActionState = { error: null }

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState(signUpAction, initialState)

  return (
    <main className="container narrow">
      <h1>Criar conta</h1>
      <form action={formAction} className="card">
        <label>
          Nome completo
          <input name="fullName" type="text" required minLength={2} autoComplete="name" />
        </label>
        <label>
          E-mail
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Senha
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        {state.error ? <p className="error">{state.error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? 'Criando...' : 'Criar conta'}
        </button>
      </form>
      <p className="muted">
        Ja tem conta? <Link href="/login">Entrar</Link>
      </p>
    </main>
  )
}
