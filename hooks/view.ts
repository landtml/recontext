// The text the bar and the /shrink panel show (design 7). Pure.

import type { ShrinkFill, ShrinkRecallRow, ShrinkRow } from '../types'
import { pad } from './util'

const BAR_WIDTH = 10
const QUESTION_CHARS = 60

/** 112345 -> "112k", 1600 -> "1.6k", 950 -> "950", undefined -> "?". */
export function kTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(n / 1000)}k`
}

/** A 10-cell bar of tokens against the threshold; '' when either is unknown. */
export function fillBar(tokens: number | undefined, threshold: number | undefined, width = BAR_WIDTH): string {
  if (tokens === undefined || threshold === undefined || threshold <= 0) return ''
  const filled = Math.min(width, Math.max(0, Math.round((tokens / threshold) * width)))
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The one line above the prompt. */
export function bandText(fill: ShrinkFill, shrinks: readonly ShrinkRow[], recalls: readonly ShrinkRecallRow[]): string {
  const context =
    fill.threshold === undefined
      ? `context ${kTokens(fill.tokens)} · auto-compact off (only /compact shrinks)`
      : `context ${kTokens(fill.tokens)} / ${kTokens(fill.threshold)} ${fillBar(fill.tokens, fill.threshold)}`.trimEnd()
  const parts = [`shrink ▸ ${context}`]
  if (shrinks.length === 0) parts.push('no shrinks yet')
  else {
    const haiku = shrinks.filter(s => s.state === 'haiku').length
    const code = shrinks.length - haiku
    const seconds = Math.round(shrinks.reduce((s, r) => s + r.ms, 0) / shrinks.length / 1000)
    const how = code === 0 ? `Haiku, ~${seconds} s each` : haiku === 0 ? 'code-only' : `${haiku} Haiku, ${code} code-only`
    parts.push(`${plural(shrinks.length, 'shrink')} (${how})`)
  }
  if (recalls.length > 0) {
    const answered = recalls.filter(r => r.outcome === 'answer' || r.outcome === 'lookup').length
    parts.push(`${plural(recalls.length, 'recall')} (${answered} answered)`)
  }
  return parts.join(' · ')
}


/** Local clock time, hh:mm. */
export function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** One shrink in the panel. */
export function shrinkLine(r: ShrinkRow): string {
  const after = r.after === undefined ? '…' : kTokens(r.after)
  const who = r.state === 'haiku' ? `Haiku ${kTokens(r.haikuTokens)} tok` : 'code-only'
  return `#${r.k} ${hhmm(r.at)}  ${r.trigger}  ${kTokens(r.before)} → ${after}  ${who}  ${(r.ms / 1000).toFixed(1)} s`
}

const OUTCOME: Record<ShrinkRecallRow['outcome'], string> = {
  answer: 'answered',
  lookup: 'exact lookup',
  'not-found': 'not found',
  raw: 'unverified passages',
  unavailable: 'unavailable',
  failed: 'failed',
}

/** One recall in the panel. */
export function recallLine(r: ShrinkRecallRow): string {
  const q = r.question.length <= QUESTION_CHARS ? r.question : `${r.question.slice(0, QUESTION_CHARS - 1)}…`
  const tries = r.tries > 0 ? ` (${plural(r.tries, 'try', 'tries')})` : ''
  return `${hhmm(r.at)}  "${q}" → ${OUTCOME[r.outcome]}${tries}`
}
