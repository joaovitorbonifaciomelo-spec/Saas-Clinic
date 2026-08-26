/** Iniciais para avatar. Sem foto: nao inventamos imagem de paciente. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

/** (11) 98888-7777 a partir dos digitos guardados no banco. */
export function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, '')
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return digits
}

const DIAS = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
]
const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
]

/** "Segunda-feira, 26 de maio de 2025" a partir de AAAA-MM-DD. */
export function fullDateLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const wd = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()
  const dia = DIAS[wd]!
  return `${dia.charAt(0).toUpperCase()}${dia.slice(1)}, ${d} de ${MESES[m! - 1]} de ${y}`
}

/** "26 de maio" — usado no intervalo da semana. */
export function shortDateLabel(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number)
  return `${d} de ${MESES[m! - 1]}`
}

export function minutesBetween(startsAt: string, endsAt: string): number {
  return Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60000)
}
