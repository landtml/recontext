import { expect, test } from 'claude-code/testing'
import type { ShrinkRecallRow, ShrinkRow } from '../types'
import { bandText, fillBar, hhmm, kTokens, recallLine, shrinkLine } from './view'

const shrink = (k: number, extra: Partial<ShrinkRow> = {}): ShrinkRow => ({ k, at: 0, trigger: 'auto', state: 'haiku', ms: 3000, ...extra })
const recall = (outcome: ShrinkRecallRow['outcome'], tries = 1): ShrinkRecallRow => ({ at: 0, question: 'q?', outcome, tries })

test('kTokens rounds to thousands; small and missing values read plainly', () => {
  expect(kTokens(112_345)).toBe('112k')
  expect(kTokens(1_600)).toBe('1.6k')
  expect(kTokens(950)).toBe('950')
  expect(kTokens(undefined)).toBe('?')
})

test('fillBar fills in proportion, capped at full', () => {
  expect(fillBar(112_000, 180_000)).toBe('▓▓▓▓▓▓░░░░')
  expect(fillBar(0, 180_000)).toBe('░░░░░░░░░░')
  expect(fillBar(400_000, 180_000)).toBe('▓▓▓▓▓▓▓▓▓▓')
  expect(fillBar(undefined, 180_000)).toBe('')
  expect(fillBar(100, undefined)).toBe('')
})

test('the bar: context against the threshold, shrinks and recalls', () => {
  expect(bandText({ tokens: 112_000, threshold: 180_000 }, [shrink(1), shrink(2, { ms: 3400 })], [recall('answer'), recall('answer'), recall('not-found')])).toBe(
    'shrink ▸ context 112k / 180k ▓▓▓▓▓▓░░░░ · 2 shrinks (Haiku, ~3 s each) · 3 recalls (2 answered)',
  )
})

test('the bar before any shrink, with mixed shrinks, and with auto-compact off', () => {
  expect(bandText({ tokens: 40_000, threshold: 180_000 }, [], [])).toBe('shrink ▸ context 40k / 180k ▓▓░░░░░░░░ · no shrinks yet')
  expect(bandText({ tokens: 40_000, threshold: 180_000 }, [shrink(1), shrink(2, { state: 'none' })], [])).toBe(
    'shrink ▸ context 40k / 180k ▓▓░░░░░░░░ · 2 shrinks (1 Haiku, 1 code-only)',
  )
  expect(bandText({ tokens: 40_000 }, [], [recall('answer')])).toBe('shrink ▸ context 40k · auto-compact off (only /compact shrinks) · no shrinks yet · 1 recall (1 answered)')
})

test('hhmm is a clock time', () => {
  expect(hhmm(Date.UTC(2026, 10, 24, 12, 5))).toMatch(/^\d\d:\d\d$/)
})

test('a shrink line: number, time, trigger, before → after, Haiku tokens, seconds', () => {
  const at = Date.UTC(2026, 10, 24, 12, 5)
  expect(shrinkLine(shrink(2, { at, before: 176_000, after: 9_000, haikuTokens: 1_600, ms: 3_400 }))).toBe(
    `#2 ${hhmm(at)}  auto  176k → 9k  Haiku 1.6k tok  3.4 s`,
  )
  expect(shrinkLine(shrink(1, { at, before: 178_000, state: 'none', ms: 40 }))).toBe(`#1 ${hhmm(at)}  auto  178k → …  code-only  0.0 s`)
})

test('a recall line: time, question (cut), outcome and tries', () => {
  const at = Date.UTC(2026, 10, 24, 12, 10)
  expect(recallLine({ at, question: 'size of blob_05.bin?', outcome: 'answer', tries: 1 })).toBe(`${hhmm(at)}  "size of blob_05.bin?" → answered (1 try)`)
  expect(recallLine({ at, question: 'x'.repeat(80), outcome: 'raw', tries: 2 })).toBe(`${hhmm(at)}  "${'x'.repeat(59)}…" → unverified passages (2 tries)`)
  expect(recallLine({ at, question: 'q', outcome: 'not-found', tries: 0 })).toBe(`${hhmm(at)}  "q" → not found`)
})
