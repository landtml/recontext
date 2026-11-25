import { expect, test } from 'claude-code/testing'
import { estimateTokens } from './budget'
import type { DigestLine } from './digest'
import { MAX_SLICES, codeNote, fitNote, pack, partNote, planShards, takeNewest } from './shard'

const L = (kind: DigestLine['kind'], n: number, size = 200): DigestLine => ({ kind, n, text: `#${n} ${kind}: ${'w'.repeat(size)}` })
const cost = (ls: readonly DigestLine[]) => ls.reduce((s, l) => s + estimateTokens(l.text) + 1, 0)

/** `turns` turns: a user line, an assistant line and two tool lines each, in messages 2t+1 and 2t+2. */
function convo(turns: number, size = 200): DigestLine[] {
  const out: DigestLine[] = []
  for (let t = 0; t < turns; t++) {
    const u = 2 * t + 1
    out.push(L('user', u, size), L('assistant', u + 1, size), L('tool', u + 1, size), L('tool', u + 1, size))
  }
  return out
}

test('pack cuts before user lines and keeps each chunk under its cap', () => {
  const lines = convo(10)
  const chunks = pack(lines, 500)
  expect(chunks.flat()).toEqual(lines)
  for (const c of chunks) {
    expect(c[0]!.kind).toBe('user')
    expect(cost(c)).toBeLessThanOrEqual(500)
  }
})

test('pack: a turn too big alone is cut between messages, then lines', () => {
  const lines = [L('user', 1), L('assistant', 2), L('tool', 2), L('tool', 2), L('tool', 2), L('tool', 3), L('tool', 3)]
  const chunks = pack(lines, 250)
  expect(chunks.flat()).toEqual(lines)
  for (const c of chunks) expect(cost(c)).toBeLessThanOrEqual(250)
  expect(chunks.length).toBeGreaterThan(1)
})

test('takeNewest takes whole turns from the end; a latest turn too big alone gives its last messages', () => {
  const lines = convo(5)
  const start = takeNewest(lines, 900)
  expect(lines[start]!.kind).toBe('user')
  expect(cost(lines.slice(start))).toBeLessThanOrEqual(900)
  const big = [L('user', 1), L('assistant', 2), L('tool', 2), L('user', 3), L('assistant', 4, 2000), L('tool', 4), L('tool', 5)]
  const s2 = takeNewest(big, 300)
  expect(s2).toBeGreaterThan(3)
  expect(cost(big.slice(s2))).toBeLessThanOrEqual(300)
})

test('a plan: newest lines raw for the merge, older ones in slices; every line in exactly one place', () => {
  const lines = convo(40)
  const plan = planShards(lines, { budget: 4000, mergeFixed: 500, sliceFixed: 500, noteTokens: 300 })
  expect(plan.dropped).toBe(0)
  expect([...plan.slices.flat(), ...plan.newest]).toEqual(lines)
  expect(plan.slices.length).toBeGreaterThan(1)
  expect(plan.slices.length).toBeLessThanOrEqual(MAX_SLICES)
  for (const s of plan.slices) {
    expect(s[0]!.kind).toBe('user')
    expect(cost(s)).toBeLessThanOrEqual(3500)
  }
  expect(plan.newest[0]!.kind).toBe('user')
  // the merge fits: fixed part, one note per slice, the newest lines
  expect(500 + plan.slices.length * 300 + cost(plan.newest)).toBeLessThanOrEqual(4000)
})

test('more older text than 6 workers can read: older lines drop, tool lines first, at most 6 slices', () => {
  const lines = convo(60)
  const plan = planShards(lines, { budget: 4000, mergeFixed: 500, sliceFixed: 500, noteTokens: 300 })
  expect(plan.slices.length).toBeLessThanOrEqual(MAX_SLICES)
  expect(plan.dropped).toBeGreaterThan(0)
  const kept = new Set([...plan.slices.flat(), ...plan.newest])
  const gone = lines.filter(l => !kept.has(l))
  expect(gone.length).toBe(plan.dropped)
  expect(gone.every(l => l.kind === 'tool')).toBe(true)
  expect(plan.newest.at(-1)).toBe(lines.at(-1))
})

test('notes are cut to their share; a failed worker leaves its user lines, marked as no notes', () => {
  expect(estimateTokens(fitNote('n'.repeat(20000), 1000))).toBeLessThanOrEqual(1000)
  expect(fitNote('short note', 1000)).toBe('short note')
  const note = codeNote([L('user', 1, 10), L('tool', 2, 10), L('user', 3, 10)], 'aborted')
  expect(note).toStartWith('(no notes: the note-taker failed on this part (aborted)')
  expect(note).toContain('#1 user:')
  expect(note).toContain('#3 user:')
  expect(note).not.toContain('#2 tool')
  expect(partNote([L('user', 4), L('tool', 9)], 2, 3, 'x')).toEqual({ part: 2, of: 3, first: 4, last: 9, text: 'x' })
})
