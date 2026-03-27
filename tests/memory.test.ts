import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initMemory, buildIndex, queryMemory, getIndexStats,
  formatQueryResults, isMemoryInitialized,
} from '../src/memory'

const TEST_DIR = join(tmpdir(), `smolerclaw-memory-test-${Date.now()}`)

function setupTestData(): void {
  mkdirSync(TEST_DIR, { recursive: true })

  // Create test memos
  writeFileSync(join(TEST_DIR, 'memos.json'), JSON.stringify([
    {
      id: 'memo1',
      content: 'Reuniao com equipe de backend sobre migracao para PostgreSQL. Definimos prazo para sexta.',
      tags: ['backend', 'postgres', 'reuniao'],
      createdAt: '2026-03-20T10:00:00Z',
      updatedAt: '2026-03-20T10:00:00Z',
    },
    {
      id: 'memo2',
      content: 'Estudar Kubernetes para o projeto de deploy. Foco em pods e services.',
      tags: ['kubernetes', 'devops', 'estudo'],
      createdAt: '2026-03-21T10:00:00Z',
      updatedAt: '2026-03-21T10:00:00Z',
    },
    {
      id: 'memo3',
      content: 'Receita de bolo de chocolate da vovo. 3 ovos, 200g chocolate, 1 xicara farinha.',
      tags: ['receita', 'pessoal'],
      createdAt: '2026-03-22T10:00:00Z',
      updatedAt: '2026-03-22T10:00:00Z',
    },
  ]))

  // Create test materials
  writeFileSync(join(TEST_DIR, 'materials.json'), JSON.stringify([
    {
      id: 'mat1',
      title: 'Guia de Deploy com Docker',
      content: 'Para fazer deploy com Docker, crie um Dockerfile na raiz do projeto. Use multi-stage builds para otimizar o tamanho da imagem. Configure health checks.',
      category: 'tecnico',
      tags: ['docker', 'deploy'],
      createdAt: '2026-03-18T10:00:00Z',
      updatedAt: '2026-03-18T10:00:00Z',
    },
    {
      id: 'mat2',
      title: 'Processo de Code Review',
      content: 'Todo PR precisa de pelo menos 2 aprovacoes. Verificar cobertura de testes acima de 80%. Rodar linter antes de submeter.',
      category: 'procedimento',
      tags: ['code-review', 'processo'],
      createdAt: '2026-03-19T10:00:00Z',
      updatedAt: '2026-03-19T10:00:00Z',
    },
  ]))

  // Create test decisions
  writeFileSync(join(TEST_DIR, 'decisions.json'), JSON.stringify([
    {
      id: 'dec1',
      title: 'Escolha do banco de dados',
      context: 'Precisamos de um banco relacional para o novo sistema de pedidos.',
      chosen: 'PostgreSQL com Neon serverless',
      alternatives: 'MySQL, SQLite, MongoDB',
      tags: ['banco', 'arquitetura'],
      createdAt: '2026-03-17T10:00:00Z',
    },
  ]))
}

function cleanup(): void {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true })
  } catch { /* ignore */ }
}

describe('Memory RAG Module', () => {
  beforeEach(() => {
    cleanup()
    setupTestData()
    initMemory(TEST_DIR)
  })

  afterEach(() => {
    cleanup()
  })

  test('initMemory creates rag directory', () => {
    expect(existsSync(join(TEST_DIR, 'rag'))).toBe(true)
    expect(isMemoryInitialized()).toBe(true)
  })

  test('getIndexStats returns empty before indexing', () => {
    const stats = getIndexStats()
    expect(stats.chunks).toBe(0)
    expect(stats.sources).toBe(0)
  })

  test('buildIndex indexes all sources', () => {
    const result = buildIndex()
    expect(result.indexed).toBeGreaterThan(0)
    expect(result.total).toBeGreaterThan(0)

    const stats = getIndexStats()
    expect(stats.chunks).toBeGreaterThan(0)
    expect(stats.sources).toBeGreaterThan(0)
    expect(stats.builtAt).toBeTruthy()
  })

  test('buildIndex is incremental — no changes on second run', () => {
    buildIndex()
    const result2 = buildIndex()
    expect(result2.indexed).toBe(0)
    expect(result2.skipped).toBeGreaterThan(0)
  })

  test('buildIndex detects changes', () => {
    buildIndex()

    // Modify a memo
    const memos = JSON.parse(readFileSync(join(TEST_DIR, 'memos.json'), 'utf-8'))
    memos[0].content = 'Conteudo atualizado sobre a migracao para PostgreSQL 16.'
    writeFileSync(join(TEST_DIR, 'memos.json'), JSON.stringify(memos))

    const result = buildIndex()
    expect(result.indexed).toBeGreaterThan(0)
  })

  test('queryMemory returns relevant results for PostgreSQL', () => {
    buildIndex()
    const results = queryMemory('PostgreSQL banco de dados')
    expect(results.length).toBeGreaterThan(0)

    // The top result should be about PostgreSQL (either memo or decision)
    const topContent = results[0].chunk.content.toLowerCase()
    expect(topContent).toContain('postgresql')
  })

  test('queryMemory returns relevant results for Docker', () => {
    buildIndex()
    const results = queryMemory('Docker deploy')
    expect(results.length).toBeGreaterThan(0)

    const topContent = results[0].chunk.content.toLowerCase()
    expect(topContent).toContain('docker')
  })

  test('queryMemory returns relevant results for receita', () => {
    buildIndex()
    const results = queryMemory('receita bolo chocolate')
    expect(results.length).toBeGreaterThan(0)

    const topContent = results[0].chunk.content.toLowerCase()
    expect(topContent).toContain('chocolate')
  })

  test('queryMemory returns empty for nonsense query', () => {
    buildIndex()
    const results = queryMemory('xyzzy foobar quux')
    expect(results.length).toBe(0)
  })

  test('queryMemory respects topK parameter', () => {
    buildIndex()
    const results = queryMemory('projeto', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  test('queryMemory returns empty when index is empty', () => {
    const results = queryMemory('anything')
    expect(results.length).toBe(0)
  })

  test('formatQueryResults formats correctly', () => {
    buildIndex()
    const results = queryMemory('PostgreSQL')
    const formatted = formatQueryResults(results)
    expect(formatted).toContain('Resultados da memoria')
    expect(formatted).toContain('[1]')
  })

  test('formatQueryResults handles empty results', () => {
    const formatted = formatQueryResults([])
    expect(formatted).toContain('Nenhum resultado')
  })

  test('index persists across re-init', () => {
    buildIndex()
    const stats1 = getIndexStats()

    // Re-initialize from same dir (simulates restart)
    initMemory(TEST_DIR)
    const stats2 = getIndexStats()

    expect(stats2.chunks).toBe(stats1.chunks)
    expect(stats2.sources).toBe(stats1.sources)
  })

  test('handles corrupted JSON files gracefully', () => {
    writeFileSync(join(TEST_DIR, 'memos.json'), '{ invalid json }}}')
    const result = buildIndex()
    // Should still index materials and decisions
    expect(result.total).toBeGreaterThan(0)
  })

  test('handles missing data files gracefully', () => {
    rmSync(join(TEST_DIR, 'memos.json'), { force: true })
    rmSync(join(TEST_DIR, 'materials.json'), { force: true })
    rmSync(join(TEST_DIR, 'decisions.json'), { force: true })
    const result = buildIndex()
    expect(result.indexed).toBe(0)
    expect(result.total).toBe(0)
  })

  test('queryMemory handles empty string query', () => {
    buildIndex()
    const results = queryMemory('')
    expect(results.length).toBe(0)
  })

  test('queryMemory handles stop-words-only query', () => {
    buildIndex()
    const results = queryMemory('the a is of')
    expect(results.length).toBe(0)
  })

  test('buildIndex handles removed sources on rebuild', () => {
    buildIndex()
    const stats1 = getIndexStats()

    // Remove memos file entirely
    rmSync(join(TEST_DIR, 'memos.json'), { force: true })
    const result = buildIndex()
    const stats2 = getIndexStats()

    // Fewer chunks now since memos are gone
    expect(stats2.chunks).toBeLessThan(stats1.chunks)
    expect(result.indexed).toBe(0) // nothing new to index, but removals happened
  })

  test('buildIndex handles empty arrays in JSON files', () => {
    writeFileSync(join(TEST_DIR, 'memos.json'), '[]')
    writeFileSync(join(TEST_DIR, 'materials.json'), '[]')
    writeFileSync(join(TEST_DIR, 'decisions.json'), '[]')
    const result = buildIndex()
    expect(result.total).toBe(0)
  })

  test('queryMemory ranking: exact term scores higher', () => {
    buildIndex()
    const results = queryMemory('Kubernetes pods services')
    expect(results.length).toBeGreaterThan(0)
    // The Kubernetes memo should be ranked first
    expect(results[0].chunk.content.toLowerCase()).toContain('kubernetes')
  })

  test('buildIndex indexes session assistant messages', () => {
    // Create a sessions directory with a session file
    const sessionsDir = join(TEST_DIR, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(join(sessionsDir, 'test-session.json'), JSON.stringify({
      id: 'test-session',
      name: 'test',
      messages: [
        { role: 'user', content: 'Tell me about machine learning' },
        { role: 'assistant', content: 'Machine learning is a branch of artificial intelligence that enables systems to learn from data and improve their performance without being explicitly programmed. Common approaches include supervised learning, unsupervised learning, and reinforcement learning.' },
      ],
      created: Date.now(),
      updated: Date.now(),
    }))

    const result = buildIndex()
    expect(result.total).toBeGreaterThan(0)

    // Should be findable via query
    const results = queryMemory('machine learning artificial intelligence')
    expect(results.length).toBeGreaterThan(0)
  })

  test('getIndexStats returns builtAt after indexing', () => {
    buildIndex()
    const stats = getIndexStats()
    expect(stats.builtAt).toBeTruthy()
    // Should be a valid ISO date
    expect(new Date(stats.builtAt!).getTime()).toBeGreaterThan(0)
  })
})
