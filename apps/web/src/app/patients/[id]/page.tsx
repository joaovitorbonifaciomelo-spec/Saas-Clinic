import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  APPOINTMENT_STATUS_LABELS,
  type AppointmentWithRelations,
  type Patient,
} from '@clinicas/shared'
import { ApiError, apiFetch } from '../../../lib/api'
import { requireActiveSession } from '../../session'
import { formatDateLabel, localDateKey, localTimeLabel } from '../../agenda/agenda-time'

export const dynamic = 'force-dynamic'

export default async function PatientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { activeClinic } = await requireActiveSession()
  const clinicId = activeClinic.clinicId
  const timezone = activeClinic.clinicTimezone

  let patient: Patient
  try {
    patient = await apiFetch<Patient>(`/api/patients/${id}`, { clinicId })
  } catch (error) {
    // Paciente inexistente e paciente de outra clinica chegam aqui do mesmo
    // jeito (404 da API) e produzem a mesma tela. Nao revelamos a diferenca.
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }

  const appointments = await apiFetch<AppointmentWithRelations[]>(
    `/api/appointments?patientId=${patient.id}`,
    { clinicId },
  )

  const now = new Date()
  // Proxima consulta: a mais proxima ainda por vir que nao foi cancelada.
  const next = appointments
    .filter((a) => a.status !== 'cancelled' && new Date(a.startsAt) >= now)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0]

  const history = [...appointments].sort((a, b) => b.startsAt.localeCompare(a.startsAt))

  return (
    <main className="container narrow">
      <h1>{patient.name}</h1>
      <div className="card">
        <p>
          <strong>Telefone:</strong> {patient.phone}
        </p>
        <p>
          {/*
            Apresentacao em pt-BR. O banco continua guardando `date` em ISO
            (AAAA-MM-DD) — a conversao e so na tela.
          */}
          <strong>Nascimento:</strong>{' '}
          {patient.birthDate ? formatDateLabel(patient.birthDate) : '—'}
        </p>
        <p>
          <strong>Convenio:</strong> {patient.insuranceProvider ?? '—'}
        </p>
      </div>

      <div className="card">
        <div className="row">
          <h2>Proxima consulta</h2>
          <Link href={`/agenda?date=${localDateKey(now, timezone)}`}>
            <button type="button">Novo agendamento</button>
          </Link>
        </div>
        {next ? (
          <p>
            <strong>
              {formatDateLabel(localDateKey(new Date(next.startsAt), timezone))} as{' '}
              {localTimeLabel(next.startsAt, timezone)}
            </strong>
            <br />
            {next.professionalName}
            {next.serviceName ? ` · ${next.serviceName}` : ''} ·{' '}
            {APPOINTMENT_STATUS_LABELS[next.status]}
          </p>
        ) : (
          <p className="muted">Nenhuma consulta futura agendada.</p>
        )}
      </div>

      <div className="card">
        <h2>Historico de agendamentos</h2>
        {history.length === 0 ? (
          <p className="muted">Nenhum agendamento registrado.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Horario</th>
                <th>Profissional</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.map((appointment) => (
                <tr key={appointment.id}>
                  <td>{formatDateLabel(localDateKey(new Date(appointment.startsAt), timezone))}</td>
                  <td>{localTimeLabel(appointment.startsAt, timezone)}</td>
                  <td>{appointment.professionalName}</td>
                  <td>{APPOINTMENT_STATUS_LABELS[appointment.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="row">
        <Link href={`/patients/${patient.id}/edit`}>
          <button type="button">Editar paciente</button>
        </Link>
        <Link href="/patients">Voltar</Link>
      </div>
    </main>
  )
}
