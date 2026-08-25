'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { signInAction, type ActionState } from '../auth-actions'

const initialState: ActionState = { error: null }

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(signInAction, initialState)

  return (
    <main className="container narrow">
      <h1>Entrar</h1>
      <form action={formAction} className="card">
        <label>
          E-mail
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Senha
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {state.error ? <p className="error">{state.error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
      <p className="muted">
        Nao tem conta? <Link href="/signup">Criar conta</Link>
      </p>
    </main>
  )
}
