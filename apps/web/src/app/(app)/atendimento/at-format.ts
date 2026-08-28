/**
 * Formatacao de tempo do Atendimento, sempre no fuso da CLINICA.
 *
 * O navegador da atendente pode estar em outro fuso — notebook configurado
 * errado, VPN, viagem. Uma mensagem registrada as 14h da clinica precisa
 * aparecer como 14h para todo mundo da clinica, ou duas pessoas olhando a mesma
 * thread discordariam sobre quando algo aconteceu.
 */

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

/** `2026-08-28` no fuso da clinica. Serve para agrupar por dia. */
export function chaveDoDia(iso: string, timezone: string): string {
  const p = partes(iso, timezone)
  return `${p.year}-${p.month}-${p.day}`
}

export function hora(iso: string, timezone: string): string {
  const p = partes(iso, timezone)
  return `${p.hour}:${p.minute}`
}

/**
 * Na fila, o que importa e "quando foi a ultima atividade" — e a resposta util
 * muda com a distancia: hoje basta a hora, ontem basta a palavra, mais longe
 * precisa da data.
 */
export function horaOuData(iso: string | null, timezone: string): string {
  if (!iso) return '—'
  const hojeKey = chaveDoDia(new Date().toISOString(), timezone)
  const key = chaveDoDia(iso, timezone)
  if (key === hojeKey) return hora(iso, timezone)

  const ontem = new Date()
  ontem.setDate(ontem.getDate() - 1)
  if (key === chaveDoDia(ontem.toISOString(), timezone)) return 'ontem'

  const p = partes(iso, timezone)
  const anoAtual = partes(new Date().toISOString(), timezone).year
  return p.year === anoAtual ? `${p.day}/${p.month}` : `${p.day}/${p.month}/${p.year}`
}

/** Separador de dia dentro da thread. */
export function rotuloDoDia(iso: string, timezone: string): string {
  const hojeKey = chaveDoDia(new Date().toISOString(), timezone)
  const key = chaveDoDia(iso, timezone)
  if (key === hojeKey) return 'Hoje'

  const ontem = new Date()
  ontem.setDate(ontem.getDate() - 1)
  if (key === chaveDoDia(ontem.toISOString(), timezone)) return 'Ontem'

  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(new Date(iso))
}
