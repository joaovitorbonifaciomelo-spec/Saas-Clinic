'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { signUpAction, type ActionState } from '../auth-actions'

const initialState: ActionState = { error: null }

export function SignUpForm() {
  const [state, formAction, pending] = useActionState(signUpAction, initialState)

  return (
    <section className="auth-card">
      <header className="auth-card-head">
        <h1>Criar conta</h1>
        <p>Cadastre-se para começar a organizar a agenda da sua clínica.</p>
      </header>

      <form action={formAction} className="auth-form">
        <label>
          Nome completo
          <input
            name="fullName"
            type="text"
            required
            minLength={2}
            autoComplete="name"
            placeholder="Como você aparece para a equipe"
          />
        </label>

        <label>
          E-mail
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="voce@clinica.com.br"
          />
        </label>

        <label>
          Senha
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Mínimo de 8 caracteres"
          />
        </label>

        {state.error ? (
          <p className="error" role="alert">
            {state.error}
          </p>
        ) : null}

        {/*
          Confirmacao de e-mail esta ativa no projeto. Dizer isso ANTES do envio
          evita o caso classico: a pessoa cria a conta, tenta entrar, e conclui
          que o cadastro falhou.
        */}
        <p className="auth-note">
          Após criar sua conta, enviaremos um e-mail de confirmação. Confirme o endereço antes de
          entrar no sistema.
        </p>

        <button type="submit" className="block lg" disabled={pending}>
          {pending ? 'Criando conta…' : 'Criar conta'}
        </button>
      </form>

      <p className="auth-alt">
        Já tem uma conta? <Link href="/login">Entrar</Link>
      </p>
    </section>
  )
}
