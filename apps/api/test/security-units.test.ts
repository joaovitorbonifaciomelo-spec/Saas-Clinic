import { describe, expect, it } from 'vitest'
import { ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common'
import { extractBearerToken } from '../src/auth/auth.guard'
import { readClinicHeader } from '../src/clinics/clinic-membership.guard'
import { mapPostgrestError } from '../src/common/postgrest-error'

describe('extractBearerToken', () => {
  it('extrai o token de um header valido', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
  })

  it('aceita o esquema em qualquer capitalizacao', () => {
    expect(extractBearerToken('bearer abc')).toBe('abc')
  })

  it('rejeita header ausente', () => {
    expect(extractBearerToken(undefined)).toBeNull()
  })

  it('rejeita esquema diferente de Bearer', () => {
    expect(extractBearerToken('Basic abc')).toBeNull()
  })

  it('rejeita Bearer sem valor', () => {
    expect(extractBearerToken('Bearer')).toBeNull()
    expect(extractBearerToken('Bearer   ')).toBeNull()
  })
})

describe('readClinicHeader', () => {
  const validUuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

  it('aceita um uuid valido', () => {
    expect(readClinicHeader(validUuid)).toBe(validUuid)
  })

  it('rejeita valor que nao e uuid', () => {
    expect(readClinicHeader('clinica-a')).toBeNull()
  })

  it('rejeita header ausente', () => {
    expect(readClinicHeader(undefined)).toBeNull()
  })

  it('rejeita tentativa de injecao no header', () => {
    expect(readClinicHeader("' or '1'='1")).toBeNull()
    expect(readClinicHeader(`${validUuid} or true`)).toBeNull()
  })

  it('usa apenas o primeiro valor quando o header vem duplicado', () => {
    expect(readClinicHeader([validUuid, 'outro'])).toBe(validUuid)
  })
})

describe('mapPostgrestError', () => {
  it('traduz violacao de policy de RLS em 403', () => {
    expect(mapPostgrestError({ code: '42501' })).toBeInstanceOf(ForbiddenException)
  })

  it('traduz duplicidade em 409', () => {
    expect(mapPostgrestError({ code: '23505' })).toBeInstanceOf(ConflictException)
  })

  it('traduz violacao de check em 400', () => {
    expect(mapPostgrestError({ code: '23514' })).toBeInstanceOf(BadRequestException)
  })

  it('nao repassa a mensagem crua do Postgres ao cliente', () => {
    const raw = 'new row violates row-level security policy for table "patients"'
    const mapped = mapPostgrestError({ code: '42501', message: raw })
    expect(JSON.stringify(mapped.getResponse())).not.toContain('row-level security')
    expect(JSON.stringify(mapped.getResponse())).not.toContain('patients')
  })

  it('codigo desconhecido vira 500 generico, nunca sucesso', () => {
    expect(mapPostgrestError({ code: 'XX000' }).getStatus()).toBe(500)
    expect(mapPostgrestError(null).getStatus()).toBe(500)
  })
})
