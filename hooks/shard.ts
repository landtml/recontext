// Map and merge for a digest over the token budget (design 3.3). Pure.
//
// The newest lines go raw to the merge call (the current task is written from raw text, never from
// notes); older lines are packed oldest first into slices that each fit one map worker's request.
// A slice is cut before a user line; a turn too big alone is cut between messages, then lines.

import { cutToTokens, estimateTokens } from './budget'
import { dropLines, type DigestLine, type PartNote } from './digest'

export const MAX_SLICES = 6
/** What one note may take in the merge request, heading included; notes are cut to it in code. */
export const NOTE_TOKENS = 3000

export type ShardPlan = {
  /** Raw lines for the merge call, in order. */
  newest: DigestLine[]
  /** Older lines, one slice per map worker, oldest first. */
  slices: DigestLine[][]
  /** Lines dropped because the older text needed more than MAX_SLICES workers. */
  dropped: number
}

export type ShardBudget = {
  /** haikuBudgetTokens. */
  budget: number
  /** The merge request less its lines and notes: identity, system, wrapper, focus, previous state. */
  mergeFixed: number
  /** A map request less its lines: identity, system, wrapper, focus. */
  sliceFixed: number
  maxSlices?: number
  noteTokens?: number
}

const lineCost = (l: DigestLine): number => estimateTokens(l.text) + 1
const cost = (ls: readonly DigestLine[]): number => ls.reduce((s, l) => s + lineCost(l), 0)

/** Splits before each user line (a turn), or wherever the message number changes (a message). */
function split(lines: readonly DigestLine[], at: 'turn' | 'message'): DigestLine[][] {
  const out: DigestLine[][] = []
  lines.forEach((l, i) => {
    const prev = lines[i - 1]
    const starts = i === 0 || (at === 'turn' ? l.kind === 'user' : l.n !== prev!.n)
    if (starts) out.push([l])
    else out[out.length - 1]!.push(l)
  })
  return out
}

/** Lines packed oldest first into chunks of at most `cap` tokens (a line over `cap` alone goes alone). */
export function pack(lines: readonly DigestLine[], cap: number): DigestLine[][] {
  const chunks: DigestLine[][] = []
  let cur: DigestLine[] = []
  let used = 0
  const flush = () => {
    if (cur.length) chunks.push(cur)
    cur = []
    used = 0
  }
  const place = (unit: DigestLine[], level: 0 | 1 | 2): void => {
    const c = cost(unit)
    if (used + c <= cap) {
      cur.push(...unit)
      used += c
    } else if (c <= cap) {
      flush()
      cur.push(...unit)
      used = c
    } else if (level === 0) for (const m of split(unit, 'message')) place(m, 1)
    else if (level === 1) for (const l of unit) place([l], 2)
    else {
      flush()
      chunks.push(unit)
    }
  }
  for (const t of split(lines, 'turn')) place(t, 0)
  flush()
  return chunks
}

/** Where the newest lines that fit `cap` start: whole turns from the end; a latest turn too big alone gives its last messages. */
export function takeNewest(lines: readonly DigestLine[], cap: number): number {
  let used = 0
  let start = lines.length
  const turns = split(lines, 'turn')
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t]!
    const c = cost(turn)
    if (used + c <= cap) {
      used += c
      start -= turn.length
      continue
    }
    if (start === lines.length) {
      // the latest turn alone is too big: its last messages, then its last lines
      for (const unit of [...split(turn, 'message')].reverse()) {
        const mc = cost(unit)
        if (used + mc > cap) {
          for (const l of [...unit].reverse()) {
            if (used + lineCost(l) > cap) break
            used += lineCost(l)
            start--
          }
          break
        }
        used += mc
        start -= unit.length
      }
    }
    break
  }
  return start
}

/**
 * The plan for a digest over budget: as few slices as the older text needs, with room in the merge for
 * one note per slice. Past `maxSlices`, older lines are dropped (tool, then assistant, then user, oldest first).
 */
export function planShards(lines: readonly DigestLine[], o: ShardBudget): ShardPlan {
  const maxSlices = o.maxSlices ?? MAX_SLICES
  const noteTokens = o.noteTokens ?? NOTE_TOKENS
  const sliceCap = o.budget - o.sliceFixed
  for (let s = 1; ; s++) {
    const start = takeNewest(lines, o.budget - o.mergeFixed - s * noteTokens)
    const older = lines.slice(0, start)
    const slices = pack(older, sliceCap)
    if (slices.length > s && s < maxSlices) continue
    if (slices.length <= maxSlices) return { newest: lines.slice(start), slices, dropped: 0 }
    let over = cost(older) - maxSlices * sliceCap
    for (;;) {
      const { kept, dropped } = dropLines(older, Math.max(1, over) * 2)
      const fewer = pack(kept, sliceCap)
      if (fewer.length <= maxSlices) return { newest: lines.slice(start), slices: fewer, dropped }
      over += Math.ceil(sliceCap / 4)
    }
  }
}

/** A map worker's note, cut to its share of the merge (heading room left). */
export function fitNote(text: string, noteTokens = NOTE_TOKENS): string {
  const cut = cutToTokens(text.trim(), noteTokens - 50)
  return cut.length < text.trim().length ? `${cut}…` : cut
}

/** The note for a slice whose worker failed: its user lines, cut to fit, marked as no notes. */
export function codeNote(slice: readonly DigestLine[], why: string, noteTokens = NOTE_TOKENS): string {
  const head = `(no notes: the note-taker failed on this part (${why}); the user's lines from it follow)`
  const said = slice.filter(l => l.kind === 'user').map(l => l.text)
  return fitNote([head, ...said].join('\n'), noteTokens)
}

/** One part's note, as the merge reads it. */
export const partNote = (slice: readonly DigestLine[], part: number, of: number, text: string): PartNote => ({
  part,
  of,
  first: slice[0]?.n ?? 0,
  last: slice[slice.length - 1]?.n ?? 0,
  text,
})
