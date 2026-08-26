'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import type { Patient } from '@clinicas/shared'
import type { PatientFormState } from './patient-actions'

const initialState: PatientFormState = { error: null }

interface PatientFormProps {
  action: (prev: PatientFormState, formData: FormData) => Promise<PatientFormState>
  patient?: Patient
  submitLabel: string
}

export function PatientForm({ action, patient, submitLabel }: PatientFormProps) {
  const [state, formAction, pending] = useActionState(action, initialState)

  return (
    <form action={formAction} className="card">
      <label>
        Nome
        <input name="name" type="text" required defaultValue={patient?.name ?? ''} />
      </label>
      <label>
        Telefone
        <input
          name="phone"
          type="tel"
          required
          placeholder="(11) 90000-0000"
          defaultValue={patient?.phone ?? ''}
        />
      </label>
      <label>
        Data de nascimento (opcional)
        <input name="birthDate" type="date" defaultValue={patient?.birthDate ?? ''} />
      </label>
      <label>
        Convenio (opcional)
        <input
          name="insuranceProvider"
          type="text"
          defaultValue={patient?.insuranceProvider ?? ''}
        />
      </label>
      {state.error ? <p className="error">{state.error}</p> : null}
      <div className="row">
        <button type="submit" disabled={pending}>
          {pending ? 'Salvando...' : submitLabel}
        </button>
        <Link href="/patients">Cancelar</Link>
      </div>
    </form>
  )
}
