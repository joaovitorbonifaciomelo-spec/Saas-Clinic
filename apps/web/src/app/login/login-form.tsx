'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { signInAction, type ActionState } from '../auth-actions'

const initialState: ActionState = { error: null }

/*
 * Somente e-mail e senha.
 *
 * Nao ha login por telefone, Google, "lembrar de mim" nem recuperacao de senha
 * porque nenhum desses fluxos existe no backend. Botao bonito que nao leva a
 * lugar nenhum e pior que a ausencia dele: a pessoa clica, nada acontece, e a
 * confianca no resto da tela cai junto.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState(signInAction, initialState)

  return (
    <section className="auth-card">
      <header className="auth-card-head">
        <h1>Bem-vindo de volta</h1>
        <p>Entre para acessar sua clínica.</p>
      </header>

      <form action={formAction} className="auth-form">
        <label>
          E-mail
          <input name="email" type="email" required autoComplete="email" placeholder="voce@clinica.com.br" />
        </label>

        <label>
          Senha
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="Sua senha"
          />
        </label>

        {state.error ? (
          <p className="error" role="alert">
            {state.error}
          </p>
        ) : null}

        <button type="submit" className="block lg" disabled={pending}>
          {pending ? 'Entrando…' : 'Entrar no sistema'}
        </button>
      </form>

      <p className="auth-alt">
        Ainda não tem uma conta? <Link href="/signup">Criar conta</Link>
      </p>
    </section>
  )
}
