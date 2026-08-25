import { z } from 'zod'

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, 'Informe seu nome.').max(120),
  email: z.email('E-mail invalido.'),
  password: z.string().min(8, 'A senha deve ter ao menos 8 caracteres.').max(72),
})

export const signInSchema = z.object({
  email: z.email('E-mail invalido.'),
  password: z.string().min(1, 'Informe a senha.'),
})

export type SignUpInput = z.infer<typeof signUpSchema>
export type SignInInput = z.infer<typeof signInSchema>

export interface UserProfile {
  id: string
  fullName: string
  email: string
}
