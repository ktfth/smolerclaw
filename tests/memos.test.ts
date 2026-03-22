import { describe, test, expect, beforeEach } from 'bun:test'
import { initMemos, saveMemo, searchMemos, listMemos, updateMemo, deleteMemo, getMemoTags, formatMemoList, formatMemoTags } from '../src/memos'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('memos', () => {
  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tinyclaw-memo-'))
    initMemos(tmpDir)
  })

  test('saveMemo creates a memo', () => {
    const memo = saveMemo('Remember to buy milk')
    expect(memo.id).toBeTruthy()
    expect(memo.content).toBe('Remember to buy milk')
    expect(memo.tags).toEqual([])
  })

  test('saveMemo extracts hashtags', () => {
    const memo = saveMemo('Deploy steps for #docker #production')
    expect(memo.tags).toContain('docker')
    expect(memo.tags).toContain('production')
  })

  test('saveMemo merges explicit tags with hashtags', () => {
    const memo = saveMemo('Config for #nginx', ['server', 'infra'])
    expect(memo.tags).toContain('nginx')
    expect(memo.tags).toContain('server')
    expect(memo.tags).toContain('infra')
  })

  test('saveMemo deduplicates tags', () => {
    const memo = saveMemo('Test #work', ['work'])
    const workCount = memo.tags.filter((t) => t === 'work').length
    expect(workCount).toBe(1)
  })

  test('listMemos returns recent first', () => {
    saveMemo('first')
    saveMemo('second')
    saveMemo('third')
    const memos = listMemos()
    expect(memos.length).toBe(3)
    expect(memos[0].content).toBe('third')
  })

  test('listMemos respects limit', () => {
    for (let i = 0; i < 5; i++) saveMemo(`memo ${i}`)
    expect(listMemos(3).length).toBe(3)
  })

  test('searchMemos by content', () => {
    saveMemo('docker compose setup')
    saveMemo('kubernetes config')
    saveMemo('docker swarm notes')
    const results = searchMemos('docker')
    expect(results.length).toBe(2)
  })

  test('searchMemos by tag', () => {
    saveMemo('step 1 #deploy')
    saveMemo('step 2 #deploy')
    saveMemo('other #random')
    const results = searchMemos('#deploy')
    expect(results.length).toBe(2)
  })

  test('searchMemos empty query returns all', () => {
    saveMemo('a')
    saveMemo('b')
    expect(searchMemos('').length).toBe(2)
  })

  test('updateMemo changes content', () => {
    const memo = saveMemo('original')
    const updated = updateMemo(memo.id, 'modified #new')
    expect(updated?.content).toBe('modified #new')
    expect(updated?.tags).toContain('new')
  })

  test('deleteMemo removes memo', () => {
    const memo = saveMemo('temp')
    expect(deleteMemo(memo.id)).toBe(true)
    expect(listMemos().length).toBe(0)
  })

  test('deleteMemo returns false for unknown', () => {
    expect(deleteMemo('nonexistent')).toBe(false)
  })

  test('getMemoTags returns sorted by count', () => {
    saveMemo('#work task 1')
    saveMemo('#work task 2')
    saveMemo('#personal note')
    const tags = getMemoTags()
    expect(tags[0].tag).toBe('work')
    expect(tags[0].count).toBe(2)
    expect(tags[1].tag).toBe('personal')
  })

  test('formatMemoList shows memos', () => {
    saveMemo('test memo #tag1')
    const text = formatMemoList(listMemos())
    expect(text).toContain('test memo')
    expect(text).toContain('#tag1')
  })

  test('formatMemoList empty', () => {
    expect(formatMemoList([])).toContain('Nenhum memo')
  })

  test('formatMemoTags empty', () => {
    expect(formatMemoTags()).toContain('Nenhuma tag')
  })
})
