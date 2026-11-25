// buildDigest: what Haiku reads at a shrink (design 3.1). Pure and deterministic.
//
// The previous handoff's state of work first, then one line per user text, assistant text and
// tool call; a tool's output appears only as a failure's first line (the index keeps the rest).
// Over budget, tool lines go first, then assistant text, then user text, oldest first.

import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { lineNo } from './archive'
import { HEADER as FACTS_HEADER, callSummary, firstErrorLine, personText } from './facts'
import { HANDOFF_HEADER } from './prompt'
import { qualifyRefs } from './refs'

// 0.2.8: 8000 and 6000 (were 4000 and 2000). At 2000, 12% of assistant texts were cut and Haiku reported them as
// unfinished; at 6000 none of 647 real ones is. The token budget still trims a digest that grows too big.
const USER_CHARS = 8000
const ASSISTANT_CHARS = 6000
const ENGINE_SUMMARY = 'This session is being continued from a previous conversation'

/** The digest's cut marker (0.2.8): says how much is left out, so the line cannot read as an unfinished message. */
export const cutMark = (left: number): string => `…[+${left} chars, full text archived]`
const cut = (s: string, cap: number): string => (s.length <= cap ? s : `${s.slice(0, cap)}${cutMark(s.length - cap)}`)
const flat = (s: string): string => s.replace(/\s*\n\s*/g, ' ⏎ ').trim()

/**
 * A handoff's state of work: its facts left out, and for a shrink handoff also its title and "This is shrink k"
 * note, which Haiku copied onto refs to new lines as `#k:n` (0.2.4). The engine's own summary stays whole.
 */
function stateBody(stripped: string): string {
  const at = stripped.indexOf(FACTS_HEADER)
  const state = (at < 0 ? stripped : stripped.slice(0, at)).trimEnd()
  if (!state.startsWith(HANDOFF_HEADER)) return state
  const heading = state.search(/^## /m)
  return heading < 0 ? state : state.slice(heading)
}

/** The previous handoff's state of work (its facts left out), or undefined when the messages hold none. */
export function previousStateOf(messages: readonly SessionMessage[]): string | undefined {
  let previous: string | undefined
  for (const m of messages) {
    if (m.role !== 'user') continue
    const stripped = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (stripped.startsWith(HANDOFF_HEADER) || stripped.startsWith(ENGINE_SUMMARY)) previous = stateBody(stripped)
  }
  return previous
}

export type DigestKind = 'tool' | 'assistant' | 'user'
/** One digest line: `#n role: text`, from message n (1-based, as in the archive). */
export type DigestLine = { kind: DigestKind; n: number; text: string }
export type DigestParts = { previous?: string; lines: DigestLine[] }
/** Notes that map workers wrote on older parts of the conversation (design 3.3), oldest first. */
export type PartNote = { part: number; of: number; first: number; last: number; text: string }

/** The previous state and one line per user text, assistant text and tool call, uncut. `prevK` as in buildDigest. */
export function digestParts(messages: readonly SessionMessage[], prevK?: number): DigestParts {
  const rows = new Map<string, { text: string; isError: boolean }>()
  for (const m of messages) for (const r of m.toolResults ?? []) rows.set(r.tool_use_id, { text: r.text, isError: r.isError })
  const failed = (u: ToolUseSummary): string | undefined => {
    const text = u.text ?? rows.get(u.tool_use_id)?.text ?? ''
    const isError = u.isError === true || (u.text === undefined && rows.get(u.tool_use_id)?.isError === true)
    const exit = u.tool === 'Bash' && /^(Error: )?Exit code [1-9]\d*/.test(text)
    return isError || exit ? firstErrorLine(text) : undefined
  }

  let previous: string | undefined
  const lines: DigestLine[] = []
  messages.forEach((m, i) => {
    const n = lineNo(i)
    if (m.role === 'user') {
      const stripped = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (stripped.startsWith(HANDOFF_HEADER) || stripped.startsWith(ENGINE_SUMMARY)) {
        previous = stateBody(stripped)
        return
      }
      const said = personText(m.text)
      if (said !== undefined) lines.push({ kind: 'user', n, text: `#${n} user: ${flat(cut(said, USER_CHARS))}` })
      return
    }
    if (m.text.trim() !== '') lines.push({ kind: 'assistant', n, text: `#${n} assistant: ${flat(cut(m.text.trim(), ASSISTANT_CHARS))}` })
    for (const u of m.toolUses ?? []) {
      const error = failed(u)
      lines.push({ kind: 'tool', n, text: `#${n} tool ${u.tool}: ${callSummary(u)}${error === undefined ? '' : ` → error: ${error}`}` })
    }
  })
  if (previous !== undefined && prevK !== undefined && prevK >= 1) previous = qualifyRefs(previous, prevK)
  return { previous, lines }
}

/** The notes section of a merge digest. */
export function notesSection(notes: readonly PartNote[]): string {
  if (notes.length === 0) return ''
  const parts = notes.map(p => `### Part ${p.part} of ${p.of} (#${p.first}–#${p.last})\n${p.text.trim()}`)
  return `## Notes from earlier parts\n${parts.join('\n\n')}\n\n`
}

/** The digest text: previous state, then notes (a merge only), then the conversation lines. */
export function renderDigest(previous: string | undefined, lines: readonly DigestLine[], notes: readonly PartNote[] = []): string {
  const head = previous === undefined ? '' : `## Previous state\n${previous}\n\n`
  return `${head}${notesSection(notes)}## Conversation\n${lines.map(l => l.text).join('\n')}`.trimEnd()
}

/**
 * Drops lines until about `over` chars are gone: tool lines first, then assistant text, then user text, oldest
 * first. Returns the lines kept, in order, and how many were dropped.
 */
export function dropLines(lines: readonly DigestLine[], over: number): { kept: DigestLine[]; dropped: number } {
  const gone = new Set<DigestLine>()
  for (const kind of ['tool', 'assistant', 'user'] as const) {
    for (const l of lines) {
      if (over <= 0) break
      if (l.kind !== kind) continue
      gone.add(l)
      over -= l.text.length + 1
    }
  }
  return { kept: lines.filter(l => !gone.has(l)), dropped: gone.size }
}

/** `prevK`: the archive the previous handoff's plain `#n` refs point into; they are shown as `#prevK:n` (0.2.3). */
export function buildDigest(messages: readonly SessionMessage[], maxChars: number, prevK?: number): string {
  const { previous, lines } = digestParts(messages, prevK)
  const full = renderDigest(previous, lines)
  if (full.length <= maxChars) return full
  const text = renderDigest(previous, dropLines(lines, full.length - maxChars).kept)
  return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars))
}
