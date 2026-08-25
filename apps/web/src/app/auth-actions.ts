'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { signInSchema, signUpSchema, createClinicSchema } from '@clinicas/shared'
import { createSupabaseServerClient } from '../lib/supabase/server'
import { apiFetch, ACTIVE_CLINIC_COOKIE } from '../lib/api'
import { cookies } from 'next/headers'

export interface ActionState {
  error: string | null
}

export async function signUpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get('fullName'),
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }
  }

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    // Lido pelo trigger handle_new_user para preencher profiles.full_name.
    options: { data: { full_name: parsed.data.fullName } },
  })

  if (error) return { error: error.message }

  redirect('/dashboard')
}

export async function signInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Dados invalidos.' }
  }

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)

  if (error) return { error: 'E-mail ou senha invalidos.' }

  redirect('/dashboard')
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()

  // Limpa tambem a clinica ativa: deixar o cookie sobrando faria o proximo
  // usuario nesta maquina comecar apontando para a clinica do anterior.
  const store = await cookies()
  store.delete(ACTIVE_CLINIC_COOKIE)

  redirect('/login')
}

export async function createClinicAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = createClinicSchema.safeParse({ name: formData.get('name') })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Nome invalido.' }
  }

  try {
    await apiFetch('/api/clinics', { method: 'POST', body: parsed.data })
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Falha ao criar clinica.' }
  }

  revalidatePath('/dashboard')
  redirect('/dashboard')
}
