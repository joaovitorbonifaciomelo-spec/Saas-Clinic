import { describe, expect, it } from 'vitest'
import { createPatientSchema, updatePatientSchema } from './patient'
import { createClinicSchema } from './clinic'
import { clinicRoleSchema } from './roles'

describe('createPatientSchema', () => {
  it('normaliza o telefone para apenas digitos', () => {
    const result = createPatientSchema.parse({ name: 'Ana Souza', phone: '(11) 98888-7777' })
    expect(result.phone).toBe('11988887777')
  })

  it('rejeita telefone curto demais depois de normalizar', () => {
    const result = createPatientSchema.safeParse({ name: 'Ana', phone: '(11) 9999' })
    expect(result.success).toBe(false)
  })

  it('remove espacos em volta do nome', () => {
    const result = createPatientSchema.parse({ name: '  Joao Lima  ', phone: '11988887777' })
    expect(result.name).toBe('Joao Lima')
  })

  it('rejeita nome de um caractere', () => {
    expect(createPatientSchema.safeParse({ name: 'A', phone: '11988887777' }).success).toBe(false)
  })

  it('aceita nascimento e convenio ausentes', () => {
    const result = createPatientSchema.parse({ name: 'Ana Souza', phone: '11988887777' })
    expect(result.birthDate).toBeUndefined()
    expect(result.insuranceProvider).toBeUndefined()
  })

  it('converte convenio vazio em null', () => {
    const result = createPatientSchema.parse({
      name: 'Ana Souza',
      phone: '11988887777',
      insuranceProvider: '   ',
    })
    expect(result.insuranceProvider).toBeNull()
  })

  it('rejeita data de nascimento fora do formato ISO', () => {
    const result = createPatientSchema.safeParse({
      name: 'Ana Souza',
      phone: '11988887777',
      birthDate: '31/12/1990',
    })
    expect(result.success).toBe(false)
  })

  it('ignora clinic_id enviado no corpo: o tenant nunca vem do cliente', () => {
    const result = createPatientSchema.parse({
      name: 'Ana Souza',
      phone: '11988887777',
      clinicId: 'clinica-de-outro-tenant',
      clinic_id: 'clinica-de-outro-tenant',
    } as Record<string, unknown>)
    expect(result).not.toHaveProperty('clinicId')
    expect(result).not.toHaveProperty('clinic_id')
  })
})

describe('updatePatientSchema', () => {
  it('aceita atualizacao parcial', () => {
    const result = updatePatientSchema.parse({ name: 'Novo Nome' })
    expect(result.name).toBe('Novo Nome')
    expect(result.phone).toBeUndefined()
  })

  it('aceita objeto vazio', () => {
    expect(updatePatientSchema.parse({})).toEqual({})
  })
})

describe('createClinicSchema', () => {
  it('remove espacos em volta do nome', () => {
    expect(createClinicSchema.parse({ name: '  Clinica Vida  ' }).name).toBe('Clinica Vida')
  })

  it('rejeita nome so com espacos', () => {
    expect(createClinicSchema.safeParse({ name: '   ' }).success).toBe(false)
  })

  it('rejeita nome acima de 120 caracteres, igual ao CHECK do banco', () => {
    expect(createClinicSchema.safeParse({ name: 'a'.repeat(121) }).success).toBe(false)
  })
})

describe('clinicRoleSchema', () => {
  it('aceita os tres papeis do enum do banco', () => {
    expect(clinicRoleSchema.parse('admin')).toBe('admin')
    expect(clinicRoleSchema.parse('attendant')).toBe('attendant')
    expect(clinicRoleSchema.parse('professional')).toBe('professional')
  })

  it('rejeita papel inventado', () => {
    expect(clinicRoleSchema.safeParse('owner').success).toBe(false)
  })
})
