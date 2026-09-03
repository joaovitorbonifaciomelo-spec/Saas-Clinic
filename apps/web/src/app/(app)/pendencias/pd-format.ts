/**
 * Formatacao de tempo de Pendencias, sempre no fuso da CLINICA.
 *
 * `hora` e `rotuloDoDia` sao reaproveitadas de `atendimento/at-format.ts` de
 * proposito: sao matematica pura de fuso horario, sem nenhum acoplamento ao
 * dominio do Atendimento. Reescreve-las aqui duplicaria uma logica que ja
 * passou por revisao, exatamente o tipo de duplicacao que o backend evitou ao
 * reusar `conversation-cursor.ts` dentro de `tasks/task-cursor.ts`.
 *
 * `instantFromLocal` vem de `agenda/agenda-time.ts` pelo mesmo motivo: e o
 * unico lugar do projeto que ja resolve corretamente virada de horario de
 * verao ao converter um par data+hora local em instante absoluto.
 */
import { hora, rotuloDoDia } from '../atendimento/at-format'
import { instantFromLocal } from '../agenda/agenda-time'

export { hora, rotuloDoDia }

function partes(iso: string, timezone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const saida: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(iso))) saida[p.type] = p.value
  return saida
}

function chaveDoDia(iso: string, timezone: string): string {
  const p = partes(iso, timezone)
  return `${p.year}-${p.month}-${p.day}`
}

/**
 * Rotulo curto de prazo para a LISTA: "hoje 14:30", "amanhã", "12/09". Nunca
 * usa a palavra "atrasada" — isso e responsabilidade da aba, nao do rotulo.
 */
export function prazoCurto(iso: string | null, timezone: string): string {
  if (!iso) return 'Sem prazo'

  const hojeKey = chaveDoDia(new Date().toISOString(), timezone)
  const key = chaveDoDia(iso, timezone)

  if (key === hojeKey) return `hoje ${hora(iso, timezone)}`

  const amanha = new Date()
  amanha.setDate(amanha.getDate() + 1)
  if (key === chaveDoDia(amanha.toISOString(), timezone)) return `amanhã ${hora(iso, timezone)}`

  const ontem = new Date()
  ontem.setDate(ontem.getDate() - 1)
  if (key === chaveDoDia(ontem.toISOString(), timezone)) return `ontem ${hora(iso, timezone)}`

  const p = partes(iso, timezone)
  const anoAtual = partes(new Date().toISOString(), timezone).year
  const data = p.year === anoAtual ? `${p.day}/${p.month}` : `${p.day}/${p.month}/${p.year}`
  return `${data} ${p.hour}:${p.minute}`
}

/** Rotulo longo, para o drawer: "28 de agosto de 2026 às 14:30". */
export function prazoLongo(iso: string | null, timezone: string): string {
  if (!iso) return 'Sem prazo definido'
  const f = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso))
  return `${f} às ${hora(iso, timezone)}`
}

/** ISO -> valor de `<input type="datetime-local">`, nas partes locais da clinica. */
export function paraDatetimeLocal(iso: string, timezone: string): string {
  const p = partes(iso, timezone)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/**
 * Valor de `<input type="datetime-local">` -> instante ISO com offset, no fuso
 * da clinica. `instantFromLocal` ja resolve a virada de horario de verao com
 * duas passadas; aqui so separamos data e hora do valor do input.
 */
export function deDatetimeLocal(valor: string, timezone: string): string {
  const [dateKey, time] = valor.split('T')
  return instantFromLocal(dateKey!, time!.slice(0, 5), timezone).toISOString()
}
