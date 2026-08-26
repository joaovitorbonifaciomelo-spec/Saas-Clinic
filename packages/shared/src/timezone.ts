import { z } from 'zod'

export const DEFAULT_TIMEZONE = 'America/Sao_Paulo'

/**
 * Valida que a string e um identificador IANA reconhecido pelo runtime.
 *
 * Nao mantemos lista propria de fusos: ela envelheceria a cada mudanca de
 * legislacao. O ICU do Node ja carrega a base tzdata, entao perguntamos a ele.
 */
export function isValidIanaTimezone(value: string): boolean {
  if (value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    isValidIanaTimezone,
    'Fuso horario invalido (use um identificador IANA, ex.: America/Sao_Paulo).',
  )
