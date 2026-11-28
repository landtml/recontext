// buildDigest: what Haiku reads at a shrink (design 3.1). Pure and deterministic.
//
// The previous handoff's state of work first, then one line per user text, assistant text and
// tool call. A failed call shows its first error line; a successful Bash, Agent, AskUserQuestion or mcp call gets
// a `#n result:` line under it with an excerpt of its output (0.2.10; the index keeps the rest).
// Over budget, result lines go first, then tool lines, then assistant text, then user text, oldest first.

import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { lineNo } from './archive'
import { HEADER as FACTS_HEADER, callSummary, firstErrorLine, isShrinkCommand, noMatchExit, personText, shellParts } from './facts'
import { HANDOFF_HEADER } from './prompt'
import { qualifyForeign, qualifyRefs } from './refs'
import { ENGINE_SUMMARY } from './util'

// 0.2.8: 8000 and 6000 (were 4000 and 2000). At 2000, 12% of assistant texts were cut and Haiku reported them as
// unfinished; at 6000 none of 647 real ones is. The token budget still trims a digest that grows too big.
const USER_CHARS = 8000
const ASSISTANT_CHARS = 6000

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
  // from `## State of work`: a section before it (messages queued mid-turn, 0.2.9) is not state
  const own = state.search(/^## State of work\b/m)
  const heading = own >= 0 ? own : state.search(/^## /m)
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

export type HandoffSource = { sid8: string; k: number; path: string }
const ARCHIVE_LINE = /^- Archive: `?(\S*?\/\d{4}-\d{2}-\d{2}_([A-Za-z0-9]+)-(\d+)\.txt)/m

/** The session and shrink whose archive a handoff names under "Where to look" (0.2.11), or undefined. */
export function handoffSource(text: string): HandoffSource | undefined {
  const m = ARCHIVE_LINE.exec(text)
  return m ? { sid8: m[2]!, k: Number(m[3]), path: m[1]! } : undefined
}

/** The source of the previous handoff the messages hold (the last one, as `previousStateOf` takes), or undefined. */
export function previousSourceOf(messages: readonly SessionMessage[]): HandoffSource | undefined {
  let source: HandoffSource | undefined
  for (const m of messages) {
    if (m.role !== 'user') continue
    const stripped = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (stripped.startsWith(HANDOFF_HEADER)) source = handoffSource(stripped)
    else if (stripped.startsWith(ENGINE_SUMMARY)) source = undefined
  }
  return source
}

/**
 * A previous state with its refs made exact: a handoff another session wrote (`sid8` given and different) cites
 * that session's archives as `sid8-k#n` (0.2.11); this session's own cites archive `prevK` as `#prevK:n` (0.2.3).
 */
function qualifyPrevious(state: string, source: HandoffSource | undefined, prevK?: number, sid8?: string): string {
  if (source && sid8 && source.sid8 !== sid8) return qualifyForeign(state, source.sid8, source.k)
  return prevK !== undefined && prevK >= 1 ? qualifyRefs(state, prevK) : state
}

/** The previous state as the digest shows it (`qualifyPrevious`), or '' when the messages hold none. */
export function qualifiedPrevious(messages: readonly SessionMessage[], prevK?: number, sid8?: string): string {
  const previous = previousStateOf(messages)
  return previous === undefined ? '' : qualifyPrevious(previous, previousSourceOf(messages), prevK, sid8)
}

export type DigestKind = 'result' | 'tool' | 'assistant' | 'user'
/** One digest line: `#n role: text`, from message n (1-based, as in the archive). */
export type DigestLine = { kind: DigestKind; n: number; text: string }
export type DigestParts = { previous?: string; lines: DigestLine[] }
/** Notes that map workers wrote on older parts of the conversation (design 3.3), oldest first. */
export type PartNote = { part: number; of: number; first: number; last: number; text: string }

const RESULT_CHARS = 100
const RESULT_TOOLS = /^(Bash|Agent|Task|AskUserQuestion|Skill|mcp__.+)$/
const READ_WORD = /^(cat|head|tail|sed|grep|egrep|rg|ls|wc|find|stat|file|diff|echo|printf|pwd|cd|awk|sort|uniq|cut|tr|nl|jq|column|basename|dirname|realpath|true|git)$/
const GIT_READ = /^(log|show|diff|status|ls-files|rev-parse|blame|grep)$/
// `S=/tmp/x` names a path for the parts after it; `T=$(cmd)` runs a command
const ASSIGNMENT = /^[A-Za-z_]\w*=[^\s`]*$/
// `2>&1` and `2>/dev/null` only move output; any other `>` writes a file
const HARMLESS_REDIRECT = /\d?>&\d|\d?>\s*\/dev\/null/g

/**
 * True when a shell command only reads: one line, and every part split at `;`, `&&`, `||` and `|` starts with a
 * reading command (`sed` only with `-n` and never `-i`, `find` without `-delete`/`-exec`) and writes no file. Its output
 * is already the file's text, so a result line would repeat what the call line names (0.2.10).
 */
export function readOnlyShell(command: string): boolean {
  const c = command.trim()
  if (c === '' || c.includes('\n') || /\btee\b/.test(c)) return false
  const reads = (part: string): boolean => {
    const text = part.replace(/^(do|then|else)\s+/, '')
    if (text === 'done' || text === 'fi' || /^for \w+ in\b/.test(text)) return !text.includes('$(')
    if (ASSIGNMENT.test(text)) return !text.includes('$(')
    const words = text.split(/\s+/)
    const cmd = (words[0] ?? '').split('/').pop() ?? ''
    if (!READ_WORD.test(cmd) || text.replace(HARMLESS_REDIRECT, '').includes('>') || text.includes('<<')) return false
    if (cmd === 'sed') return words.includes('-n') && !words.some(w => /^-\w*i/.test(w) || w.startsWith('--in-place'))
    if (cmd === 'find') return !words.some(w => /^-(delete|exec|execdir|ok|fprint\w*)$/.test(w))
    if (cmd === 'git') return GIT_READ.test(words[1] ?? '')
    if (cmd === 'awk') return !/\bsystem\s*\(|\|\s*"/.test(text)
    return true
  }
  return shellParts(c).every(({ text }) => reads(text))
}
const FAIL_MARK = /^\(fail\)|\bFAILED\b|^Traceback\b|^(error|Error|ERROR)(\[\w+\])?:/
const SUMMARY = /^\d+ (pass|fail|skip)\b|\b\d+ (passed|failed|skipped|errors?)\b/
// Output, not commands: a secret word only counts with a value after it ("token budget" is not a secret).
const OUTPUT_SECRET =
  /\bBearer\s+\S{8,}|\bsk-[\w-]{10,}|\bgh[pousr]_\w{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[\w-]{10,}\.[\w-]{10,}|\b\w*(token|password|passwd|secret|api[_-]?key)\w*\s*[:=]\s*\S{8,}/i

// what the harness adds after a command's own output (0.2.10): often the only last line, so it is skipped
const HARNESS_NOTICE = /^Shell cwd was reset to |^\(Bash completed with no output\)$|^\[This command modified \d+ files?\b/
// the recall tool's first line labels its answer as data; the answer follows
const EXCEPTION = /^[\w.]*(Error|Exception|Interrupt|Exit)\b.*:|^[\w.]*(Error|Exception)$/
const RECALL_HEADER = /^Recall \(archived conversation data\b/

function bashOutcome(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '' && !HARNESS_NOTICE.test(l))
  if (lines.length === 0) return '(no output)'
  let fail = lines.find(l => FAIL_MARK.test(l))
  // a traceback's header says nothing; its exception line ("KeyError: 'name'") says what failed
  if (fail !== undefined && /^Traceback\b/.test(fail)) fail = lines.slice(lines.indexOf(fail) + 1).find(l => EXCEPTION.test(l)) ?? fail
  const sums = lines.filter(l => l !== fail && SUMMARY.test(l)).slice(-3).map(l => l.replace(/^=+\s*|\s*=+$/g, ''))
  const parts = [fail, sums.join(', ')].filter((p): p is string => p !== undefined && p !== '')
  if (parts.length > 0) return parts.join(' · ')
  // a closing "}" or "})" ends JSON and code listings; the last line with a word or number says more
  return [...lines].reverse().find(l => /[\p{L}\p{N}]/u.test(l)) ?? lines[lines.length - 1]!
}

/**
 * The `#n result:` text for a successful call, or undefined for tools whose output says little (reads, searches,
 * edits). Pure; the caller drops the line on any exception (0.2.10).
 */
export function resultLine(tool: string, text: string): string | undefined {
  if (!RESULT_TOOLS.test(tool)) return undefined
  const first = text.split(/\r?\n/).map(l => l.trim()).find(l => l !== '' && !RECALL_HEADER.test(l)) ?? '(no output)'
  let out: string
  if (tool === 'Bash' && /^Command running in background with ID:/.test(first)) out = '(started in the background)'
  else if (tool === 'Bash') out = bashOutcome(text)
  else if ((tool === 'Agent' || tool === 'Task') && /^Async agent launched/.test(first)) out = '(started in the background)'
  else if (tool === 'AskUserQuestion') {
    const answers = [...text.matchAll(/"="(.*?)"(?=, "|\.\s+You\b|\.?\s*$)/gs)].map(m => m[1]!)
    out = answers.length > 0 ? `answered: ${answers.join(' | ')}` : first
  } else out = first
  // only the line shown can leak; code listings elsewhere in the output ("maxTokens: X") withheld 60 lines (0.2.10)
  if (OUTPUT_SECRET.test(out)) return '(output withheld: may hold a secret)'
  const flatOut = flat(out)
  return flatOut.length <= RESULT_CHARS ? flatOut : `${flatOut.slice(0, RESULT_CHARS)}…`
}

/**
 * The previous state and one line per user text, assistant text and tool call, uncut. `prevK` as in buildDigest;
 * `sid8`: this session, so a previous handoff another session wrote keeps that session's refs (0.2.11).
 */
export function digestParts(messages: readonly SessionMessage[], prevK?: number, sid8?: string): DigestParts {
  const rows = new Map<string, { text: string; isError: boolean }>()
  for (const m of messages) for (const r of m.toolResults ?? []) rows.set(r.tool_use_id, { text: r.text, isError: r.isError })
  const failed = (u: ToolUseSummary): string | undefined => {
    const text = u.text ?? rows.get(u.tool_use_id)?.text ?? ''
    const isError = u.isError === true || (u.text === undefined && rows.get(u.tool_use_id)?.isError === true)
    const exit = u.tool === 'Bash' && /^(Error: )?Exit code [1-9]\d*/.test(text)
    if (!isError && !exit) return undefined
    const command = u.input?.command
    // exit 1 from a last grep or diff is a result, not a failure (0.2.10)
    if (u.tool === 'Bash' && typeof command === 'string' && noMatchExit(command, text)) return undefined
    return firstErrorLine(text)
  }
  const outcome = (u: ToolUseSummary): string | undefined => {
    try {
      const text = u.text ?? rows.get(u.tool_use_id)?.text
      if (text === undefined) return undefined
      const command = u.input?.command
      if (u.tool === 'Bash' && typeof command === 'string' && readOnlyShell(command)) return undefined
      return resultLine(u.tool, text)
    } catch {
      return undefined
    }
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
      const said = isShrinkCommand(m.text) ? undefined : personText(m.text)
      if (said !== undefined) lines.push({ kind: 'user', n, text: `#${n} user: ${flat(cut(said, USER_CHARS))}` })
      return
    }
    if (m.text.trim() !== '') lines.push({ kind: 'assistant', n, text: `#${n} assistant: ${flat(cut(m.text.trim(), ASSISTANT_CHARS))}` })
    for (const u of m.toolUses ?? []) {
      const error = failed(u)
      lines.push({ kind: 'tool', n, text: `#${n} tool ${u.tool}: ${callSummary(u)}${error === undefined ? '' : ` → error: ${error}`}` })
      const result = error === undefined ? outcome(u) : undefined
      if (result !== undefined) lines.push({ kind: 'result', n, text: `#${n} result: ${result}` })
    }
  })
  if (previous !== undefined) previous = qualifyPrevious(previous, previousSourceOf(messages), prevK, sid8)
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
  for (const kind of ['result', 'tool', 'assistant', 'user'] as const) {
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
