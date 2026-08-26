import { createHash } from 'node:crypto'
import type { AppointmentWarning } from '@clinicas/shared'

/**
 * Impressao digital do conjunto de avisos apresentado ao usuario.
 *
 * O problema que isto resolve: um `acknowledge: true` generico autorizaria
 * qualquer conflito, inclusive um que surgiu DEPOIS que o aviso foi exibido.
 * Entre ver a tela e clicar em confirmar, outra recepcionista pode ter marcado
 * algo no mesmo horario — e o usuario teria autorizado as cegas um encaixe que
 * nunca viu.
 *
 * Com o fingerprint, o cliente confirma um conjunto ESPECIFICO de avisos. No
 * reenvio o servidor recalcula tudo: se a situacao mudou, o hash muda, a
 * confirmacao nao vale e um novo 409 leva o aviso atualizado de volta a tela.
 *
 * A serializacao precisa ser canonica — mesma situacao, mesmo hash — por isso
 * os campos sao escolhidos e ordenados explicitamente, sem depender da ordem em
 * que o banco devolveu as linhas nem de JSON.stringify sobre objetos livres.
 */
export function fingerprintWarnings(warnings: AppointmentWarning[]): string {
  const parts: string[] = []

  for (const warning of [...warnings].sort((a, b) => a.type.localeCompare(b.type))) {
    if (warning.type === 'overlap') {
      // Ordena por id para que a ordem de retorno do banco nao afete o hash.
      // starts/ends/status entram porque mover ou cancelar um conflitante muda
      // materialmente o que o usuario precisa avaliar.
      const rows = [...warning.appointments]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => `${a.id}|${a.startsAt}|${a.endsAt}|${a.status}`)
        .join(';')
      parts.push(`overlap:${rows}`)
    } else {
      const windows = [...warning.availability]
        .map((w) => `${w.startTime}-${w.endTime}`)
        .sort()
        .join(';')
      parts.push(`outside_availability:${warning.weekday}:${windows}`)
    }
  }

  return createHash('sha256').update(parts.join('||'), 'utf8').digest('hex')
}

/** Hash de 64 hex; o schema zod exige exatamente esse tamanho. */
export function isWellFormedFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}
