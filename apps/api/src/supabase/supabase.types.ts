import type { SupabaseClient } from '@supabase/supabase-js'

/** Client Supabase ja vinculado ao JWT do usuario da requisicao. */
export type UserScopedClient = SupabaseClient

/** Token injetado pelo Nest para obter esse client. */
export const SUPABASE_USER_CLIENT = 'SUPABASE_USER_CLIENT'
