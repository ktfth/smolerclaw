import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initBrCompany,
  normalizeCnpj,
  formatCnpj,
  normalizeCep,
  formatCep,
  normalizeDomain,
  isBrDomain,
  formatCompany,
  formatCepInfo,
  formatDomain,
  clearBrCompanyCache,
  getBrCompanyCacheStats,
  type BrCompany,
  type BrCep,
  type BrDomainInfo,
} from '../src/br-company'

describe('br-company: normalizers', () => {
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'smolerclaw-brco-'))
    initBrCompany(tmp)
    clearBrCompanyCache()
  })

  test('normalizeCnpj strips mask and returns 14 digits', () => {
    expect(normalizeCnpj('00.000.000/0001-91')).toBe('00000000000191')
    expect(normalizeCnpj('00000000000191')).toBe('00000000000191')
    expect(normalizeCnpj('  00.000.000/0001-91  ')).toBe('00000000000191')
  })

  test('normalizeCnpj rejects wrong length', () => {
    expect(normalizeCnpj('123')).toBeNull()
    expect(normalizeCnpj('000000000001911')).toBeNull()
    expect(normalizeCnpj('')).toBeNull()
  })

  test('normalizeCnpj rejects repeated-digit strings', () => {
    expect(normalizeCnpj('00000000000000')).toBeNull()
    expect(normalizeCnpj('99999999999999')).toBeNull()
  })

  test('formatCnpj applies official mask', () => {
    expect(formatCnpj('00000000000191')).toBe('00.000.000/0001-91')
  })

  test('formatCnpj passes through malformed input', () => {
    expect(formatCnpj('abc')).toBe('abc')
  })

  test('normalizeCep strips hyphen', () => {
    expect(normalizeCep('01311-000')).toBe('01311000')
    expect(normalizeCep('01311000')).toBe('01311000')
  })

  test('normalizeCep rejects wrong length', () => {
    expect(normalizeCep('1234')).toBeNull()
    expect(normalizeCep('')).toBeNull()
  })

  test('formatCep applies mask', () => {
    expect(formatCep('01311000')).toBe('01311-000')
  })

  test('normalizeDomain lowercases, strips protocol and path', () => {
    expect(normalizeDomain('https://www.Example.com.br/about')).toBe('example.com.br')
    expect(normalizeDomain('http://registro.br')).toBe('registro.br')
    expect(normalizeDomain('FOO.BAR.BR')).toBe('foo.bar.br')
  })

  test('normalizeDomain rejects invalid input', () => {
    expect(normalizeDomain('')).toBeNull()
    expect(normalizeDomain('nodot')).toBeNull()
    expect(normalizeDomain('spaces .br')).toBeNull()
  })

  test('isBrDomain recognizes .br', () => {
    expect(isBrDomain('example.com.br')).toBe(true)
    expect(isBrDomain('foo.br')).toBe(true)
    expect(isBrDomain('example.com')).toBe(false)
    expect(isBrDomain('not-a-domain')).toBe(false)
  })
})

describe('br-company: formatters', () => {
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'smolerclaw-brco-'))
    initBrCompany(tmp)
  })

  test('formatCompany renders the key sections', () => {
    const company: BrCompany = {
      cnpj: '00000000000191',
      razaoSocial: 'EMPRESA EXEMPLO LTDA',
      nomeFantasia: 'Exemplo',
      situacaoCadastral: 'ATIVA',
      dataSituacao: '2000-01-01',
      dataAbertura: '1999-06-15',
      cnae: { codigo: '6201500', descricao: 'Desenvolvimento de software' },
      endereco: {
        logradouro: 'Av. Paulista',
        numero: '1000',
        bairro: 'Bela Vista',
        municipio: 'Sao Paulo',
        uf: 'SP',
        cep: '01311000',
      },
      telefone: '1122223333',
      partners: [
        { nome: 'Fulano de Tal', qualificacao: 'Socio-Administrador' },
      ],
      fetchedAt: Date.now(),
      source: 'brasilapi',
    }
    const out = formatCompany(company)
    expect(out).toContain('EMPRESA EXEMPLO LTDA')
    expect(out).toContain('00.000.000/0001-91')
    expect(out).toContain('ATIVA')
    expect(out).toContain('Desenvolvimento de software')
    expect(out).toContain('Av. Paulista')
    expect(out).toContain('Sao Paulo/SP')
    expect(out).toContain('01311-000')
    expect(out).toContain('Fulano de Tal')
    expect(out).toContain('BrasilAPI')
  })

  test('formatCompany handles minimal data', () => {
    const minimal: BrCompany = {
      cnpj: '00000000000191',
      razaoSocial: 'X',
      partners: [],
      fetchedAt: Date.now(),
      source: 'brasilapi',
    }
    const out = formatCompany(minimal)
    expect(out).toContain('X')
    expect(out).toContain('00.000.000/0001-91')
  })

  test('formatCepInfo renders CEP details', () => {
    const cep: BrCep = {
      cep: '01311000',
      estado: 'SP',
      cidade: 'Sao Paulo',
      bairro: 'Bela Vista',
      logradouro: 'Av. Paulista',
      servico: 'open-cep',
      fetchedAt: Date.now(),
      source: 'brasilapi',
    }
    const out = formatCepInfo(cep)
    expect(out).toContain('01311-000')
    expect(out).toContain('Av. Paulista')
    expect(out).toContain('Sao Paulo/SP')
    expect(out).toContain('open-cep')
  })

  test('formatDomain renders RDAP sections', () => {
    const info: BrDomainInfo = {
      domain: 'example.com.br',
      status: ['active'],
      nameservers: ['a.dns.br', 'b.dns.br'],
      events: [
        { action: 'registration', date: '2020-01-01' },
        { action: 'last changed', date: '2024-05-10' },
      ],
      contacts: [
        { role: 'registrant', handle: 'ABC123', name: 'Owner Name' },
        { role: 'technical', handle: 'XYZ789' },
      ],
      fetchedAt: Date.now(),
      source: 'registro.br',
    }
    const out = formatDomain(info)
    expect(out).toContain('example.com.br')
    expect(out).toContain('active')
    expect(out).toContain('a.dns.br')
    expect(out).toContain('b.dns.br')
    expect(out).toContain('registration')
    expect(out).toContain('2020-01-01')
    expect(out).toContain('registrant')
    expect(out).toContain('Owner Name')
    expect(out).toContain('Registro.br RDAP')
  })
})

describe('br-company: cache lifecycle', () => {
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'smolerclaw-brco-'))
    initBrCompany(tmp)
    clearBrCompanyCache()
  })

  test('starts with empty cache', () => {
    const stats = getBrCompanyCacheStats()
    expect(stats.cnpj).toBe(0)
    expect(stats.cep).toBe(0)
    expect(stats.domain).toBe(0)
  })

  test('clearBrCompanyCache is idempotent', () => {
    clearBrCompanyCache()
    clearBrCompanyCache()
    expect(getBrCompanyCacheStats().cnpj).toBe(0)
  })
})
