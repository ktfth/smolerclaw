/**
 * Brazilian company lookup — OSINT from public, official sources.
 *
 * Resolves a CNPJ, domain, or CEP against public Brazilian registries so the
 * user can back their work with verifiable data (due diligence, client/vendor
 * cadastro, project context, research).
 *
 * Sources (all public, no auth required):
 *   - BrasilAPI   https://brasilapi.com.br  — CNPJ and CEP endpoints
 *   - Registro.br RDAP https://rdap.registro.br — .br domain WHOIS/RDAP
 *
 * Results are cached locally for 24h to avoid hammering public APIs.
 * No external npm deps — uses built-in fetch / AbortController.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './vault'

// ─── Types ──────────────────────────────────────────────────

/** Partner / administrator of a company (quadro societario) */
export interface BrPartner {
  nome: string
  qualificacao?: string
  /** CPF/CNPJ partially masked by the API (e.g. ***.123.456-**) */
  documento?: string
  entrada?: string
}

/** CNPJ registration data as returned by BrasilAPI's /cnpj/v1 endpoint. */
export interface BrCompany {
  cnpj: string
  razaoSocial: string
  nomeFantasia?: string
  situacaoCadastral?: string
  dataSituacao?: string
  dataAbertura?: string
  cnae?: {
    codigo?: string
    descricao?: string
  }
  endereco?: {
    logradouro?: string
    numero?: string
    complemento?: string
    bairro?: string
    municipio?: string
    uf?: string
    cep?: string
  }
  telefone?: string
  email?: string
  capitalSocial?: number
  naturezaJuridica?: string
  porte?: string
  partners: BrPartner[]
  /** Timestamp (ms) when the data was fetched. */
  fetchedAt: number
  source: 'brasilapi'
}

/** CEP (Brazilian ZIP) lookup result. */
export interface BrCep {
  cep: string
  estado?: string
  cidade?: string
  bairro?: string
  logradouro?: string
  servico?: string
  fetchedAt: number
  source: 'brasilapi'
}

/** .br domain RDAP data (public WHOIS). */
export interface BrDomainInfo {
  domain: string
  status?: string[]
  nameservers: string[]
  events: { action: string; date?: string }[]
  /** Contacts publicly exposed by Registro.br (usually just handles for .br). */
  contacts: { role: string; handle?: string; name?: string }[]
  fetchedAt: number
  source: 'registro.br'
}

type CacheEntry<T> = { cachedAt: number; data: T }

interface CacheFile {
  cnpj: Record<string, CacheEntry<BrCompany>>
  cep: Record<string, CacheEntry<BrCep>>
  domain: Record<string, CacheEntry<BrDomainInfo>>
}

// ─── State ──────────────────────────────────────────────────

let _dataDir = ''
let _cache: CacheFile = { cnpj: {}, cep: {}, domain: {} }

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const FETCH_TIMEOUT_MS = 10_000

const CACHE_FILE = () => join(_dataDir, 'br-company-cache.json')

// ─── Init ───────────────────────────────────────────────────

export function initBrCompany(dataDir: string): void {
  _dataDir = dataDir
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  loadCache()
}

function loadCache(): void {
  const file = CACHE_FILE()
  if (!existsSync(file)) {
    _cache = { cnpj: {}, cep: {}, domain: {} }
    return
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    _cache = {
      cnpj: parsed.cnpj || {},
      cep: parsed.cep || {},
      domain: parsed.domain || {},
    }
  } catch {
    _cache = { cnpj: {}, cep: {}, domain: {} }
  }
}

function saveCache(): void {
  if (!_dataDir) return
  try {
    atomicWriteFile(CACHE_FILE(), JSON.stringify(_cache, null, 2))
  } catch {
    // best effort — cache is a convenience, not a source of truth
  }
}

// ─── Normalizers / validators ───────────────────────────────

/** Strips formatting and returns the 14-digit CNPJ, or null if invalid shape. */
export function normalizeCnpj(raw: string): string | null {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length !== 14) return null
  if (/^(\d)\1{13}$/.test(digits)) return null // all same digit — invalid
  return digits
}

/** Formats a 14-digit CNPJ with the official mask: 00.000.000/0000-00 */
export function formatCnpj(cnpj: string): string {
  const d = (cnpj || '').replace(/\D/g, '')
  if (d.length !== 14) return cnpj
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
}

/** Strips formatting and returns the 8-digit CEP, or null if invalid shape. */
export function normalizeCep(raw: string): string | null {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length !== 8) return null
  return digits
}

/** Formats an 8-digit CEP as 00000-000 */
export function formatCep(cep: string): string {
  const d = (cep || '').replace(/\D/g, '')
  if (d.length !== 8) return cep
  return `${d.slice(0, 5)}-${d.slice(5)}`
}

/**
 * Normalizes a domain: trims, lowercases, strips protocol/path.
 * Returns null if the string is empty or obviously not a domain.
 */
export function normalizeDomain(raw: string): string | null {
  if (!raw) return null
  let s = raw.trim().toLowerCase()
  s = s.replace(/^https?:\/\//, '')
  s = s.replace(/^www\./, '')
  s = s.split('/')[0]
  s = s.split('?')[0]
  if (!s || !s.includes('.')) return null
  if (!/^[a-z0-9.-]+$/.test(s)) return null
  return s
}

/** True if the domain is under a .br TLD (directly or as a subdomain). */
export function isBrDomain(domain: string): boolean {
  const d = normalizeDomain(domain)
  if (!d) return false
  return d.endsWith('.br')
}

// ─── HTTP helper ────────────────────────────────────────────

async function httpGetJson<T>(url: string, accept = 'application/json'): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': accept,
        'User-Agent': 'smolerclaw/br-company (public-osint)',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      if (res.status === 404) throw new Error('not_found')
      if (res.status === 429) throw new Error('rate_limited')
      throw new Error(`http_${res.status}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Public lookups ─────────────────────────────────────────

/**
 * Fetch company data for a CNPJ from BrasilAPI.
 * Returns cached data if present and fresh (< 24h).
 * Throws on network failure, 404, or malformed CNPJ.
 */
export async function lookupCnpj(raw: string, opts: { refresh?: boolean } = {}): Promise<BrCompany> {
  const cnpj = normalizeCnpj(raw)
  if (!cnpj) throw new Error('invalid_cnpj')

  if (!opts.refresh) {
    const cached = _cache.cnpj[cnpj]
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.data
    }
  }

  const url = `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`
  const raw_json = await httpGetJson<Record<string, unknown>>(url)

  const company = parseBrasilApiCnpj(cnpj, raw_json)

  _cache.cnpj[cnpj] = { cachedAt: Date.now(), data: company }
  saveCache()

  return company
}

/**
 * Fetch CEP data from BrasilAPI (/cep/v2).
 * Returns cached data if fresh.
 */
export async function lookupCep(raw: string, opts: { refresh?: boolean } = {}): Promise<BrCep> {
  const cep = normalizeCep(raw)
  if (!cep) throw new Error('invalid_cep')

  if (!opts.refresh) {
    const cached = _cache.cep[cep]
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.data
    }
  }

  const url = `https://brasilapi.com.br/api/cep/v2/${cep}`
  const raw_json = await httpGetJson<Record<string, unknown>>(url)

  const data: BrCep = {
    cep,
    estado: str(raw_json.state),
    cidade: str(raw_json.city),
    bairro: str(raw_json.neighborhood),
    logradouro: str(raw_json.street),
    servico: str(raw_json.service),
    fetchedAt: Date.now(),
    source: 'brasilapi',
  }

  _cache.cep[cep] = { cachedAt: Date.now(), data }
  saveCache()

  return data
}

/**
 * Fetch public .br domain data via Registro.br RDAP.
 * RDAP (RFC 7483) is the modern replacement for WHOIS and returns structured JSON.
 */
export async function lookupDomain(raw: string, opts: { refresh?: boolean } = {}): Promise<BrDomainInfo> {
  const domain = normalizeDomain(raw)
  if (!domain) throw new Error('invalid_domain')
  if (!domain.endsWith('.br')) throw new Error('not_br_domain')

  if (!opts.refresh) {
    const cached = _cache.domain[domain]
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.data
    }
  }

  const url = `https://rdap.registro.br/domain/${domain}`
  const raw_json = await httpGetJson<Record<string, unknown>>(url, 'application/rdap+json, application/json')

  const data = parseRdapDomain(domain, raw_json)

  _cache.domain[domain] = { cachedAt: Date.now(), data }
  saveCache()

  return data
}

// ─── Parsers ────────────────────────────────────────────────

function parseBrasilApiCnpj(cnpj: string, raw: Record<string, unknown>): BrCompany {
  const partners: BrPartner[] = []
  const qsa = raw.qsa
  if (Array.isArray(qsa)) {
    for (const item of qsa) {
      if (!item || typeof item !== 'object') continue
      const p = item as Record<string, unknown>
      partners.push({
        nome: str(p.nome_socio) || '(sem nome)',
        qualificacao: str(p.qualificacao_socio),
        documento: str(p.cnpj_cpf_do_socio),
        entrada: str(p.data_entrada_sociedade),
      })
    }
  }

  return {
    cnpj,
    razaoSocial: str(raw.razao_social) || '(sem razao social)',
    nomeFantasia: str(raw.nome_fantasia),
    situacaoCadastral: str(raw.descricao_situacao_cadastral) || str(raw.situacao_cadastral),
    dataSituacao: str(raw.data_situacao_cadastral),
    dataAbertura: str(raw.data_inicio_atividade),
    cnae: {
      codigo: str(raw.cnae_fiscal),
      descricao: str(raw.cnae_fiscal_descricao),
    },
    endereco: {
      logradouro: str(raw.logradouro),
      numero: str(raw.numero),
      complemento: str(raw.complemento),
      bairro: str(raw.bairro),
      municipio: str(raw.municipio),
      uf: str(raw.uf),
      cep: str(raw.cep),
    },
    telefone: str(raw.ddd_telefone_1),
    email: str(raw.email),
    capitalSocial: typeof raw.capital_social === 'number' ? raw.capital_social : undefined,
    naturezaJuridica: str(raw.natureza_juridica),
    porte: str(raw.porte),
    partners,
    fetchedAt: Date.now(),
    source: 'brasilapi',
  }
}

function parseRdapDomain(domain: string, raw: Record<string, unknown>): BrDomainInfo {
  // RDAP: nameservers is an array of { ldhName, ... }
  const nameservers: string[] = []
  if (Array.isArray(raw.nameservers)) {
    for (const ns of raw.nameservers) {
      if (ns && typeof ns === 'object') {
        const ldh = str((ns as Record<string, unknown>).ldhName)
        if (ldh) nameservers.push(ldh.toLowerCase())
      }
    }
  }

  // events: [{ eventAction: 'registration', eventDate: '...' }]
  const events: { action: string; date?: string }[] = []
  if (Array.isArray(raw.events)) {
    for (const ev of raw.events) {
      if (ev && typeof ev === 'object') {
        const e = ev as Record<string, unknown>
        events.push({
          action: str(e.eventAction) || '(unknown)',
          date: str(e.eventDate),
        })
      }
    }
  }

  // entities: publicly, Registro.br exposes handles/roles
  const contacts: { role: string; handle?: string; name?: string }[] = []
  if (Array.isArray(raw.entities)) {
    for (const ent of raw.entities) {
      if (!ent || typeof ent !== 'object') continue
      const e = ent as Record<string, unknown>
      const roles = Array.isArray(e.roles) ? e.roles.filter((r): r is string => typeof r === 'string') : []
      const role = roles.join(',') || '(unknown)'
      contacts.push({
        role,
        handle: str(e.handle),
        name: extractVcardName(e.vcardArray),
      })
    }
  }

  const status: string[] = Array.isArray(raw.status)
    ? raw.status.filter((s): s is string => typeof s === 'string')
    : []

  return {
    domain,
    status,
    nameservers,
    events,
    contacts,
    fetchedAt: Date.now(),
    source: 'registro.br',
  }
}

/**
 * Pulls "fn" (full name) out of an RDAP vcardArray if present.
 * vcardArray format is ["vcard", [["version",...], ["fn", {}, "text", "Nome"], ...]]
 */
function extractVcardName(vcardArray: unknown): string | undefined {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return undefined
  const props = vcardArray[1]
  if (!Array.isArray(props)) return undefined
  for (const prop of props) {
    if (Array.isArray(prop) && prop[0] === 'fn' && typeof prop[3] === 'string') {
      return prop[3]
    }
  }
  return undefined
}

// ─── Formatters (for TUI output) ────────────────────────────

export function formatCompany(c: BrCompany): string {
  const lines: string[] = []
  lines.push(`--- ${c.razaoSocial} ---`)
  lines.push(`CNPJ:       ${formatCnpj(c.cnpj)}`)
  if (c.nomeFantasia) lines.push(`Fantasia:   ${c.nomeFantasia}`)
  if (c.situacaoCadastral) {
    const extra = c.dataSituacao ? ` (desde ${c.dataSituacao})` : ''
    lines.push(`Situacao:   ${c.situacaoCadastral}${extra}`)
  }
  if (c.dataAbertura) lines.push(`Abertura:   ${c.dataAbertura}`)
  if (c.naturezaJuridica) lines.push(`Natureza:   ${c.naturezaJuridica}`)
  if (c.porte) lines.push(`Porte:      ${c.porte}`)
  if (typeof c.capitalSocial === 'number') {
    lines.push(`Capital:    R$ ${c.capitalSocial.toFixed(2)}`)
  }

  if (c.cnae?.codigo || c.cnae?.descricao) {
    const code = c.cnae.codigo ? `[${c.cnae.codigo}] ` : ''
    lines.push(`CNAE:       ${code}${c.cnae.descricao || ''}`.trimEnd())
  }

  const e = c.endereco
  if (e && (e.logradouro || e.municipio)) {
    const street = [e.logradouro, e.numero].filter(Boolean).join(', ')
    const extras = [e.complemento, e.bairro].filter(Boolean).join(' - ')
    const city = [e.municipio, e.uf].filter(Boolean).join('/')
    const cepFmt = e.cep ? formatCep(e.cep) : ''
    lines.push('Endereco:')
    if (street) lines.push(`  ${street}`)
    if (extras) lines.push(`  ${extras}`)
    if (city || cepFmt) lines.push(`  ${city}${cepFmt ? ` — CEP ${cepFmt}` : ''}`)
  }

  if (c.telefone) lines.push(`Telefone:   ${c.telefone}`)
  if (c.email) lines.push(`Email:      ${c.email}`)

  if (c.partners.length > 0) {
    lines.push('')
    lines.push(`Socios (${c.partners.length}):`)
    for (const p of c.partners) {
      const doc = p.documento ? ` ${p.documento}` : ''
      const qual = p.qualificacao ? ` — ${p.qualificacao}` : ''
      lines.push(`  - ${p.nome}${doc}${qual}`)
    }
  }

  lines.push('')
  lines.push(`Fonte: BrasilAPI  |  Cache: ${formatAge(c.fetchedAt)}`)

  return lines.join('\n')
}

export function formatCepInfo(c: BrCep): string {
  const lines: string[] = []
  lines.push(`--- CEP ${formatCep(c.cep)} ---`)
  if (c.logradouro) lines.push(`Logradouro: ${c.logradouro}`)
  if (c.bairro) lines.push(`Bairro:     ${c.bairro}`)
  if (c.cidade || c.estado) {
    lines.push(`Cidade:     ${[c.cidade, c.estado].filter(Boolean).join('/')}`)
  }
  if (c.servico) lines.push(`Servico:    ${c.servico}`)
  lines.push('')
  lines.push(`Fonte: BrasilAPI  |  Cache: ${formatAge(c.fetchedAt)}`)
  return lines.join('\n')
}

export function formatDomain(d: BrDomainInfo): string {
  const lines: string[] = []
  lines.push(`--- ${d.domain} ---`)
  if (d.status && d.status.length > 0) {
    lines.push(`Status:     ${d.status.join(', ')}`)
  }
  if (d.events.length > 0) {
    lines.push('Eventos:')
    for (const ev of d.events) {
      const date = ev.date ? ` ${ev.date}` : ''
      lines.push(`  ${ev.action.padEnd(18)}${date}`)
    }
  }
  if (d.nameservers.length > 0) {
    lines.push('Nameservers:')
    for (const ns of d.nameservers) {
      lines.push(`  ${ns}`)
    }
  }
  if (d.contacts.length > 0) {
    lines.push('Contatos:')
    for (const c of d.contacts) {
      const handle = c.handle ? ` (${c.handle})` : ''
      const name = c.name ? ` — ${c.name}` : ''
      lines.push(`  ${c.role}${handle}${name}`)
    }
  }
  lines.push('')
  lines.push(`Fonte: Registro.br RDAP  |  Cache: ${formatAge(d.fetchedAt)}`)
  return lines.join('\n')
}

// ─── Cache introspection ────────────────────────────────────

export function clearBrCompanyCache(): void {
  _cache = { cnpj: {}, cep: {}, domain: {} }
  saveCache()
}

export function getBrCompanyCacheStats(): { cnpj: number; cep: number; domain: number } {
  return {
    cnpj: Object.keys(_cache.cnpj).length,
    cep: Object.keys(_cache.cep).length,
    domain: Object.keys(_cache.domain).length,
  }
}

// ─── Helpers ────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim()
    return t.length > 0 ? t : undefined
  }
  if (typeof v === 'number') return String(v)
  return undefined
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins}min atras`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h atras`
  const days = Math.floor(hours / 24)
  return `${days}d atras`
}
