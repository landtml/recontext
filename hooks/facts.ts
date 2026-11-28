// buildFacts: exact facts the summarizer would otherwise have to remember (spec 3.3). Pure and
// deterministic: same input, same output. Every list is oldest first; when a cap or the budget
// is hit, the oldest entries drop and a "+N more" line says where the rest is.

import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { lineNo } from './archive'
import type { IndexEntry } from './index'
import { HANDOFF_HEADER, type Where } from './prompt'
import { squash, str, stringsOf } from './util'

export type FactsOptions = Where & {
  verbatimUserMessages: number
  factsBudgetChars: number
  /** This session's earlier handoff files, oldest first: what earlier resets kept. */
  earlierResets?: readonly string[]
  /** This session's earlier archives, oldest first, as [k, path]: where `#k:n` refs point (0.2.3). */
  earlierArchives?: readonly (readonly [number, string])[]
  /** The archive a handoff another session wrote names (a fork, or a resume under a new id): where `sid8-k#n` refs point (0.2.11). */
  continuesArchive?: string
  /** The state of work this handoff carries: names it already holds are not listed again (0.2.9). */
  stateText?: string
  /** The home folder, shown as `~` in commands (0.2.9). */
  home?: string
  /** The session index's items, best first (`rankEntries`, 0.3.0): when given, its slice replaces Files touched and Names in play. */
  ranked?: readonly IndexEntry[]
  /** The slice's budget in estimated tokens (0.3.0: 5,000). */
  sliceTokens?: number
}

const CAPS = {
  verbatimChars: 4000,
  earlierChars: 160,
  earlierLines: 40,
  files: 60,
  failures: 30,
  urls: 30,
  agents: 20,
  fieldChars: 200,
  commands: 8,
  commandChars: 200,
  names: 40,
}

export const HEADER = '# Handoff facts (exact, extracted by code)'

// ---------------------------------------------------------------- the user's own words

/**
 * Rows the engine makes in the user's role; none of them is the person's words. HEADER is
 * this mod's own facts message from an earlier reset, which sits in the transcript as a user row.
 */
const MACHINE_PREFIXES = [
  HEADER,
  HANDOFF_HEADER,
  '[Request interrupted by user',
  '<task-notification>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  'This session is being continued from a previous conversation',
  'Base directory for this skill:',
  '[Image: source:',
]

/**
 * The person's words in a user message: `<system-reminder>` blocks stripped, a slash
 * command shown as typed, and undefined for a row the engine made.
 */
export function personText(text: string): string | undefined {
  const stripped = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (stripped === '') return undefined
  if (MACHINE_PREFIXES.some(p => stripped.startsWith(p))) return undefined
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(stripped)
  if (command) {
    const name = command[1]!.trim()
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(stripped)?.[1]?.trim() ?? ''
    if (name === '/compact' && args === '') return undefined // the reset itself, nothing asked
    return `${name}${args ? ` ${args}` : ''}`
  }
  return stripped
}

/**
 * A message that is only a shrink or compact command (0.2.11): `/shrink now` with its focus text, or `/compact` with its
 * args. The command is not the person's words, and the focus text reaches Haiku another way. A plain message with more
 * lines after the command is the person's own words, so it stays.
 */
export function isShrinkCommand(text: string): boolean {
  const said = personText(text)?.trim()
  return said !== undefined && /^\/(?:shrink\s+now|compact)\b/.test(said) && !said.includes('\n')
}

// ---------------------------------------------------------------- helpers

const ellipsis = (s: string, cap: number): string => (s.length <= cap ? s : `${s.slice(0, cap - 1)}…`)
/** 0.2.9 steps run guarded: a throw gives what 0.2.8 had there (nothing), never a failed shrink. */
const safe = <T>(f: () => T, fallback: T): T => {
  try {
    return f()
  } catch {
    return fallback
  }
}

type Outcome = { text?: string; isError: boolean }

const ERROR_WORD = /error|\berr\b|exception|fatal|denied|no such|not found|cannot|can't|failed|refused|invalid/i
const SHELL_ERROR = /^[\w.\/-]+: (.+: )?(cannot|can't) |No such file or directory|command not found|Permission denied|hook error|^\w*(Error|Exception):/
// a call that never ran: a hook blocked it or the person said no; it changed nothing (0.2.10)
const BLOCKED = /^PreToolUse:\S+ hook error|tool use was rejected/m
const MATCH_TOOL = /^(grep|egrep|fgrep|rg|diff|cmp)$/

/** The top-level parts of one shell line, split at `;`, `&&`, `||` and `|`, quotes and `$( )` kept whole. */
export function shellParts(line: string): { sep: string; text: string }[] {
  const parts: { sep: string; text: string }[] = []
  let quote: string | undefined
  let depth = 0
  let start = 0
  let sep = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = undefined
    } else if (ch === '\\') i++
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (ch === ';' || (ch === '|' && line[i - 1] !== '>') || (ch === '&' && line[i + 1] === '&'))) {
      parts.push({ sep, text: line.slice(start, i).trim() })
      sep = ch === ';' ? ';' : line[i + 1] === ch ? ch + ch : ch
      if (sep.length === 2) i++
      start = i + 1
    }
  }
  parts.push({ sep, text: line.slice(start).trim() })
  return parts.filter(p => p.text !== '')
}

/**
 * True when a Bash call's exit 1 only means "no match" or "files differ": the last command that ran is a grep, rg,
 * diff or cmp, other output came before it and no line looks like an error. Such a call worked (0.2.10: a
 * `…; diff before after && echo SAME` was once listed as failed). A lone grep that found nothing is still a failure.
 */
export function noMatchExit(command: string, text: string): boolean {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  if (!/^(Error: )?Exit code 1$/.test(lines[0] ?? '')) return false
  const body = lines.slice(1)
  if (body.length === 0 || body.some(l => ERROR_WORD.test(l))) return false
  const parts = shellParts(command.trim().split('\n').pop() ?? '')
  // `x && echo SAME` exiting 1: x failed and the echo never ran
  while (parts.length > 1 && parts[parts.length - 1]!.sep === '&&' && /^(echo|printf)\b/.test(parts[parts.length - 1]!.text)) parts.pop()
  let last = parts[parts.length - 1]?.text ?? ''
  for (let k = 0; k < 4; k++) last = last.replace(/^(timeout\s+\S+\s+|env\s+\w+=\S+\s+|[A-Z]\w*=\S+\s+|command\s+)/, '')
  const tool = (last.split(/\s+/)[0] ?? '').split('/').pop() ?? ''
  return MATCH_TOOL.test(tool)
}

export function firstErrorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
  const exit = lines.map(l => /^(?:Error: )?(Exit code \d+)$/.exec(l.trim())?.[1]).find(x => x !== undefined)
  const body = lines.filter(l => !/^(Error: )?Exit code \d+$/.test(l.trim()))
  // a shell's own error beats printed text that only mentions errors (0.2.10: a `cat` of notes once won over `ls: cannot access`)
  const shell = body.find(l => SHELL_ERROR.test(l.trim()))
  if (shell !== undefined) return shell.trim()
  const flagged = body.find(l => !/^\s*Traceback\b/.test(l) && ERROR_WORD.test(l))
  if (flagged !== undefined) return flagged.trim()
  // a non-zero exit with no error-looking line: say so, rather than show an output line as if it were the error (0.2.9)
  if (exit !== undefined) return body.length ? `${exit}; last line: ${body[body.length - 1]!.trim()}` : `${exit}; no output`
  return (body[0] ?? lines[0] ?? '(no output)').trim()
}

/** The answers in an AskUserQuestion result, matched to the questions the call asked (0.2.9). */
export function answersOf(input: Record<string, unknown> | undefined, text: string): { question: string; answer: string }[] {
  const asked = Array.isArray(input?.questions) ? (input.questions as unknown[]) : []
  const questions = asked.flatMap(q => (typeof (q as { question?: unknown })?.question === 'string' ? [(q as { question: string }).question] : []))
  const found = questions
    .map(question => ({ question, at: text.indexOf(`"${question}"="`) }))
    .filter(f => f.at >= 0)
    .sort((a, b) => a.at - b.at)
  return found.flatMap((f, i) => {
    const from = f.at + f.question.length + 4
    const next = found[i + 1]?.at
    const end = next !== undefined ? next : text.indexOf('". You can now continue', from)
    const raw = end < 0 ? text.slice(from, text.lastIndexOf('"') > from ? text.lastIndexOf('"') : undefined) : text.slice(from, end)
    const answer = raw.replace(/",\s*$/, '').trim()
    return answer === '' ? [] : [{ question: f.question, answer }]
  })
}

/** Files a shell command changes by `sed -i`, `>`/`>>` redirection or `tee` (0.2.9). Heredoc bodies and quoted
 *  text are not read as commands; targets with `$`, globs or /dev/ are skipped; a relative path follows `cd /abs`. */
export function shellWrites(command: string): string[] {
  const kept: string[] = []
  let until: string | undefined
  for (const line of command.split('\n')) {
    if (until !== undefined) {
      if (line.trim() === until) until = undefined
      continue
    }
    kept.push(line)
    const h = /<<-?\s*(['"]?)([\w-]+)\1/.exec(line)
    if (h) until = h[2]
  }
  const quoted: string[] = []
  const masked = kept.join('\n').replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, m => {
    quoted.push(m.slice(1, -1))
    return `\u0000${quoted.length - 1}\u0000`
  })
  const unquote = (t: string): string => t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => quoted[Number(i)]!)
  const out: string[] = []
  let cwd: string | undefined
  const add = (raw: string) => {
    const t = unquote(raw).replace(/^\.\//, '')
    if (t === '' || /[\s$`*?]/.test(t) || t.startsWith('&') || t.startsWith('/dev/')) return
    const p = t.startsWith('/') || t.startsWith('~') || cwd === undefined ? t : `${cwd}/${t}`
    if (!out.includes(p)) out.push(p)
  }
  for (const seg of masked.split(/&&|\|\||[;|\n]/)) {
    const tokens = seg.trim().split(/\s+/).filter(t => t !== '')
    if (tokens[0] === 'cd' && tokens[1] !== undefined) {
      const dir = unquote(tokens[1]).replace(/\/+$/, '')
      cwd = dir.startsWith('/') || dir.startsWith('~') ? dir : undefined
      continue
    }
    if (tokens[0] === 'sed' && tokens.some(t => t.startsWith('-i') || t === '--in-place')) {
      const args: string[] = []
      let script = false
      for (let j = 1; j < tokens.length; j++) {
        const t = tokens[j]!
        if (/[<>]/.test(t)) break
        if (t === '-e' || t === '-f') {
          script = true
          j++
        } else if (!t.startsWith('-')) args.push(t)
      }
      for (const f of script ? args : args.slice(1)) add(f)
    }
    if (tokens[0] === 'tee') for (const t of tokens.slice(1)) if (!t.startsWith('-') && !/[<>]/.test(t)) add(t)
    for (const m of seg.matchAll(/(?:^|[^<>&\d=-])>>?\s*([^\s;&|<>()]+)/g)) add(m[1]!)
  }
  return out
}

export function callSummary(use: ToolUseSummary): string {
  const i = use.input ?? {}
  const s =
    str(i.command) ?? str(i.file_path) ?? str(i.notebook_path) ?? str(i.url) ?? str(i.pattern) ??
    str(i.description) ?? str(i.query) ?? JSON.stringify(i)
  return ellipsis(squash(s), CAPS.fieldChars)
}

function urlsIn(command: string): string[] {
  return (command.match(/https?:\/\/[^\s'"`<>()[\]{}|\\^]+/g) ?? []).map(u => u.replace(/[.,;:!?]+$/, ''))
}

/** Keyed entries ordered by last touch: a repeat moves the key to the end. */
class Recency<V> {
  private readonly map = new Map<string, V>()
  touch(key: string, make: () => V): V {
    const v = this.map.get(key) ?? make()
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }
  entries(): [string, V][] {
    return [...this.map.entries()]
  }
  keys(): string[] {
    return [...this.map.keys()]
  }
}

// ---------------------------------------------------------------- commands that worked, names in play (0.2.9)

/** Not recipes: reads, one-off scripts, plain shell plumbing. */
const NOT_RECIPE =
  /^(sed|grep|rg|ugrep|cat|ls|head|tail|find|wc|echo|printf|mkdir|rm|for|while|if|set|stat|diff|jq|sort|pwd|which|date|sleep|true|file|du|df|tree|realpath|readlink|xxd|od|test)\b|^git (status|log|diff|show|branch)\b|^(\S*\/)?(python3?(\.\d+)?|node|bun) (-I )?-(c|e)?\b|<</
/** Never offered for re-running: changes outside the work tree, or not undoable. */
const SIDE_EFFECT =
  /\brm\s|\bgit\s+(push|commit|reset|clean|tag|rebase)\b|\bgh\s+(release|repo|pr\s+(create|merge))\b|\bnpm\s+publish\b|\bcurl\b.*\s-X\s*(POST|PUT|PATCH|DELETE)\b|--force\b/
/** Never written into a handoff. */
const SECRET = /=\S{20,}|\bBearer\b|\b(token|password|passwd|secret|api[_-]?key)\b|\bsk-[\w-]{10,}|\bgh[pousr]_\w{10,}/i

/** What makes two commands the same recipe: the first three words after `cd X &&`, `VAR=x`, `set -e`, `time`,
 *  `timeout N` and `env X=Y`. */
export function commandKey(command: string): string {
  let c = command.trim().split('\n')[0]!
  for (let k = 0; k < 6; k++)
    c = c.replace(/^(cd \S+|[A-Z]\w*=\S+|set -e)\s*(&&|;)\s*/, '').replace(/^(\(?time\s+|timeout\s+\d+\s+|env\s+\w+=\S+\s+)/, '')
  return c.split(/\s+/).filter(w => w !== '').slice(0, 3).join(' ')
}

/** The command as a recipe: cut at the first top-level `|`, `||` or `;` after the command itself, so one-off
 *  filters (`| grep x | head`) and unrelated next steps (`; sed -n …`) are not offered for re-running; `&&` chains,
 *  quoted text and `$( )` stay whole, and a `2>&1` left dangling by the cut goes too. */
export function recipeForm(command: string): string {
  const c = command.trim()
  let rest = c
  for (let k = 0; k < 6; k++)
    rest = rest.replace(/^(cd \S+|[A-Z]\w*=\S+|set -e)\s*(&&|;)\s*/, '').replace(/^(\(?time\s+|timeout\s+\d+\s+|env\s+\w+=\S+\s+)/, '')
  let quote: string | undefined
  let depth = 0
  for (let i = c.length - rest.length; i < c.length; i++) {
    const ch = c[i]!
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = undefined
    } else if (ch === '\\') i++
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0 && (ch === ';' || (ch === '|' && c[i - 1] !== '>')))
      return c.slice(0, i).replace(/\s*2>&1\s*$/, '').trimEnd()
  }
  return c
}

const recipeLike = (command: string): boolean =>
  !command.includes('\n') &&
  !command.includes('`') &&
  command.length <= CAPS.commandChars &&
  !NOT_RECIPE.test(commandKey(command)) &&
  !SIDE_EFFECT.test(command) &&
  !SECRET.test(command)

const COMMANDS_TITLE = 'Commands that worked (ran ok; check before re-running)'
const COMMAND_LINE = /^- `(.+)` \(ok (\d+)x\)$/

/** The commands the last handoff in these messages listed, as [command, count], in its order. */
function carriedCommands(messages: readonly SessionMessage[]): [string, number][] {
  let last: string | undefined
  for (const m of messages) {
    if (m.role !== 'user') continue
    const s = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (s.startsWith(HANDOFF_HEADER)) last = s
  }
  if (last === undefined) return []
  const from = last.indexOf(`\n## ${COMMANDS_TITLE}`, Math.max(0, last.indexOf(HEADER)))
  if (from < 0) return []
  const out: [string, number][] = []
  for (const line of last.slice(from + 1).split('\n').slice(1)) {
    if (line.startsWith('## ')) break
    const m = COMMAND_LINE.exec(line.trim())
    if (m && recipeLike(m[1]!)) out.push([m[1]!, Number(m[2])])
  }
  return out
}

/** Identifiers: a letter or _ then 4+ word characters, with a lowercase letter and an uppercase letter, digit or _
 *  past the first character (`buildFacts`, `max_tokens`, `v029Plan`); hex ids (`c0ffee12`) are not names. */
const IDENT = /\b(?=\w*[a-z])(?=\w\w*?[A-Z_0-9])[A-Za-z_]\w{4,}\b/g
const HEXISH = /^[0-9a-f]+$/
const DUNDER = /^__\w+__$/
/** A plain word with a version or size (`python3`, `sha256`, `base64`): a tool, not a name in play. */
const VERSIONED = /^[a-z]+\d+$/
/** `\nSHEET` in code text is an escape, not the name `nSHEET`. */
const ESCAPES = /\\[ntr]/g


// ---------------------------------------------------------------- sections

/** `noMore`: entries dropped for the budget leave no "+N more" line (a name list has nowhere to point).
 *  `dropLast`: a ranked list, so the budget drops from its end. */
type Section = { title: string; entries: string[]; dropped: number; join: string; noMore?: boolean; dropLast?: boolean; more?: (n: number) => string }

function capOldest(entries: string[], cap: number): { entries: string[]; dropped: number } {
  const dropped = Math.max(0, entries.length - cap)
  return { entries: entries.slice(dropped), dropped }
}

function moreLine(n: number, where: Where): string {
  if (where.archivePath) return `+${n} more: grep the archive`
  if (where.transcriptPath) return `+${n} more: search the original transcript`
  return `+${n} more (not kept)`
}

function renderSection(s: Section, where: Where): string {
  const lines = [`## ${s.title}`]
  if (s.dropped > 0 && !s.noMore) lines.push(s.more ? s.more(s.dropped) : moreLine(s.dropped, where))
  return `${lines.join('\n')}\n${s.entries.join(s.join)}`.trimEnd()
}

function render(sections: Section[], where: Where): string {
  const shown = sections.filter(s => s.entries.length > 0 || (s.dropped > 0 && !s.noMore))
  return [HEADER, ...shown.map(s => renderSection(s, where))].join('\n\n')
}

/** The earlier handoff files: their shared folder once, then the names (saves ~150 chars a file). */
function earlierResetsLine(paths: readonly string[], title = '- Earlier resets of this session (summary and facts each)'): string {
  const sep = (p: string): number => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  const dir = paths[0]!.slice(0, sep(paths[0]!) + 1)
  const shared = dir !== '' && paths.every(p => p.startsWith(dir) && sep(p.slice(dir.length)) < 0)
  return shared ? `${title}, in ${dir}: ${paths.map(p => p.slice(dir.length)).join(', ')}` : `${title}: ${paths.join(', ')}`
}

// ---------------------------------------------------------------- buildFacts

export const SLICE_TOKENS = 5000
export const SLICE_TITLE = 'Items in play (exact names from the session index, best ranked first)'
/** Characters per slice line: short lines let the facts budget drop the slice from its end. */
const SLICE_LINE = 400

/** True when the text already holds the item: as written, or a path by its last two segments. */
export function heldIn(item: string, textLc: string): boolean {
  const i = item.toLowerCase()
  if (textLc.includes(i)) return true
  if (!i.includes('/')) return false
  const tail = i.replace(/\/+$/, '').split('/').slice(-2).join('/')
  return tail.length >= 6 && textLc.includes(tail)
}

/**
 * The index slice (0.3.0): ranked index items, each written in full as `` `item` ``, packed into `budgetTokens` est.
 * tokens (2 chars each). Paths stay whole: grouping by folder with per-item refs kept fewer
 * items useful in testing; refs come from recall. An item that does not fit is passed over, so a smaller one
 * later can still fit; `more` counts every item left out that `skip` did not remove.
 */
export function indexSlice(ranked: readonly IndexEntry[], budgetTokens: number, skip: (item: string) => boolean): { lines: string[]; packed: number; more: number } {
  const budget = 2 * budgetTokens
  const lines: string[] = []
  let line = ''
  let used = 0
  let packed = 0
  let more = 0
  for (const e of ranked) {
    if (skip(e.item)) continue
    const piece = `\`${e.item}\``
    const fresh = !line || line.length + piece.length + 1 > SLICE_LINE
    const cost = piece.length + (fresh ? 3 : 1) // "- " and "\n" open a line, " " joins
    if (used + cost > budget) {
      more++
      continue
    }
    if (fresh && line) lines.push(line)
    line = fresh ? `- ${piece}` : `${line} ${piece}`
    used += cost
    packed++
  }
  if (line) lines.push(line)
  return { lines, packed, more }
}

export function buildFacts(messages: readonly SessionMessage[], opts: FactsOptions): string {
  const where: Where = { archivePath: opts.archivePath, transcriptPath: opts.transcriptPath }

  // outcomes, from the call itself or from the tool_result row that answers it
  const outcome = new Map<string, Outcome>()
  for (const m of messages)
    for (const r of m.toolResults ?? []) outcome.set(r.tool_use_id, { text: r.text, isError: r.isError })
  const outcomeOf = (u: ToolUseSummary): Outcome =>
    u.text !== undefined || u.isError ? { text: u.text, isError: u.isError === true } : outcome.get(u.tool_use_id) ?? { isError: false }

  const said: { n: number; text: string }[] = []
  const files = new Recency<{ R: number; W: number; E: number; S: number }>()
  const urls = new Recency<true>()
  const failures: string[] = []
  const agents: string[] = []
  const runs = new Map<string, { form: string; n: number; at: number }>()
  for (const [j, [form, n]] of safe(() => carriedCommands(messages), []).entries()) {
    const key = commandKey(form)
    if (!runs.has(key)) runs.set(key, { form, n, at: -1 - j })
  }
  const nameScore = new Map<string, number>()
  const span = Math.max(1, messages.length)

  // the user's answers to AskUserQuestion are their own words (0.2.9), at the line of the result
  const asks = new Map<string, ToolUseSummary>()
  const resultRows = new Set<string>()
  for (const m of messages) {
    for (const u of m.toolUses ?? []) if (u.tool === 'AskUserQuestion') asks.set(u.tool_use_id, u)
    for (const r of m.toolResults ?? []) resultRows.add(r.tool_use_id)
  }
  const answered = (n: number, use: ToolUseSummary | undefined, text: string | undefined) => {
    if (use === undefined || text === undefined) return
    for (const a of safe(() => answersOf(use.input, text), [])) said.push({ n, text: `[answer to "${ellipsis(squash(a.question), 120)}"] ${a.answer}` })
  }
  const blank = () => ({ R: 0, W: 0, E: 0, S: 0 })
  // a shell path that is relative (no `cd` seen) or starts with ~ joins the one listed file it ends like
  const resolve = (p: string): string => {
    if (p.startsWith('/')) return p
    const tail = p.startsWith('~') ? p.slice(1) : `/${p}`
    const like = files.keys().filter(k => k !== p && k.endsWith(tail))
    return like.length === 1 ? like[0]! : p
  }

  messages.forEach((m, i) => {
    const n = lineNo(i)
    if (m.role === 'assistant')
      safe(() => {
        for (const b of [m.text, ...(m.toolUses ?? []).map(u => stringsOf(u.input))])
          for (const w of new Set(b.replace(ESCAPES, ' ').match(IDENT) ?? []))
            if (!HEXISH.test(w) && !DUNDER.test(w) && !VERSIONED.test(w)) nameScore.set(w, (nameScore.get(w) ?? 0) + 1 + (2 * i) / span)
      }, undefined)
    if (m.role === 'user') {
      const text = personText(m.text)
      if (text !== undefined && !isShrinkCommand(m.text)) said.push({ n, text })
      for (const r of m.toolResults ?? []) if (!r.isError) answered(n, asks.get(r.tool_use_id), r.text)
    }
    for (const u of m.toolUses ?? []) {
      const input = u.input ?? {}
      const path = str(input.file_path) ?? str(input.notebook_path)
      const action =
        u.tool === 'Read' ? 'R' : u.tool === 'Write' ? 'W' : ['Edit', 'MultiEdit', 'NotebookEdit'].includes(u.tool) ? 'E' : undefined
      const out = outcomeOf(u)
      // a failed or blocked call changed nothing; a shell command that ran and then failed may have (0.2.10)
      if (path && action && !out.isError) files.touch(path, blank)[action]++
      if (u.tool === 'Bash' && str(input.command) && !BLOCKED.test(out.text ?? ''))
        for (const p of safe(() => shellWrites(input.command as string), [])) files.touch(safe(() => resolve(p), p), blank).S++
      if (u.tool === 'AskUserQuestion' && !resultRows.has(u.tool_use_id) && !u.isError) answered(n, u, u.text)

      if (u.tool === 'WebFetch' && str(input.url)) urls.touch(input.url as string, () => true)
      if (u.tool === 'Bash' && str(input.command)) for (const url of urlsIn(input.command as string)) urls.touch(url, () => true)

      const nonZeroExit = u.tool === 'Bash' && /^(Error: )?Exit code [1-9]\d*/.test(out.text ?? '')
      const noMatch = u.tool === 'Bash' && str(input.command) !== undefined && safe(() => noMatchExit(input.command as string, out.text ?? ''), false)
      if ((out.isError || nonZeroExit) && !noMatch)
        failures.push(`- #${n} ${u.tool}: ${callSummary(u)} → ${ellipsis(firstErrorLine(out.text ?? ''), CAPS.fieldChars)}`)
      else if (u.tool === 'Bash' && str(input.command))
        safe(() => {
          let form = (input.command as string).trim()
          if (opts.home && opts.home.length > 1) form = form.split(opts.home.replace(/\/+$/, '')).join('~')
          if (!recipeLike(form)) return
          form = recipeForm(form)
          const key = commandKey(form)
          runs.set(key, { form, n: (runs.get(key)?.n ?? 0) + 1, at: i })
        }, undefined)

      if (u.tool === 'Agent') {
        const id = u.agentId ?? /agentId: ([\w-]+)/.exec(out.text ?? '')?.[1]
        const desc = ellipsis(squash(str(input.description) ?? str(input.prompt) ?? '(no description)'), CAPS.fieldChars)
        const type = str(input.subagent_type) ? ` [${input.subagent_type as string}]` : ''
        agents.push(`- #${n} ${desc}${type}${id ? ` agentId ${id}` : out.isError ? ' (no agent started)' : ''}`)
      }
    }
  })

  const nVerbatim = Math.max(0, Math.floor(opts.verbatimUserMessages))
  const recent = nVerbatim === 0 ? [] : said.slice(-nVerbatim)
  const older = said.slice(0, said.length - recent.length)

  const verbatimEntries = recent.map(({ n, text }) =>
    text.length > CAPS.verbatimChars
      ? `### #${n}\n${text.slice(0, CAPS.verbatimChars)}… [cut at ${CAPS.verbatimChars} of ${text.length} chars: archive #${n}]`
      : `### #${n}\n${text}`,
  )
  const make = (title: string, all: string[], cap: number, join = '\n'): Section => ({ title, join, ...capOldest(all, cap) })

  const verbatim = make("The user's last messages, verbatim (oldest first)", verbatimEntries, Infinity, '\n\n')
  const earlier = make(
    'Earlier messages (one line each; #n is the archive line)',
    older.map(({ n, text }) => `- #${n} ${ellipsis(squash(text), CAPS.earlierChars)}`),
    CAPS.earlierLines,
  )
  const filesS = make(
    'Files touched (R read, W written, E edited, S changed by a shell command; counts)',
    files.entries().map(([p, c]) => `- ${p}  ${(['R', 'W', 'E', 'S'] as const).filter(k => c[k] > 0).map(k => `${k}${c[k]}`).join(' ')}`),
    CAPS.files,
  )
  const failS = make('Failed commands and errors', failures, CAPS.failures)
  const urlS = make('URLs fetched', urls.entries().map(([u]) => `- ${u}`), CAPS.urls)
  const agentS = make('Agents spawned', agents, CAPS.agents)
  const commandS = make(
    COMMANDS_TITLE,
    [...runs.values()]
      .filter(r => r.n >= 2)
      .sort((a, b) => b.n - a.n || b.at - a.at)
      .slice(0, CAPS.commands)
      .map(r => `- \`${r.form}\` (ok ${r.n}x)`),
    CAPS.commands,
  )

  const whereLines: string[] = []
  if (where.archivePath) whereLines.push(`- Archive: ${where.archivePath} (one line per message: \`#n role tool | text\`)`)
  if (where.transcriptPath) whereLines.push(`- Original transcript: ${where.transcriptPath}`)
  if (opts.earlierResets?.length) whereLines.push(earlierResetsLine(opts.earlierResets))
  if (opts.earlierArchives?.length)
    whereLines.push(
      earlierResetsLine(
        opts.earlierArchives.map(([, p]) => p),
        `- Earlier archives (\`#k:n\` is line n of shrink k's archive: ${opts.earlierArchives.map(([k]) => k).join(', ')})`,
      ),
    )
  const continues = opts.continuesArchive && /_([A-Za-z0-9]+)-\d+\.txt$/.exec(opts.continuesArchive)?.[1]
  if (opts.continuesArchive && continues)
    whereLines.push(`- Archive of the session this one continues (its refs read \`${continues}-k#n\`): ${opts.continuesArchive}`)
  if (whereLines.length === 0) whereLines.push('- No archive or transcript was kept for this session.')
  const whereS: Section = { title: 'Where to look', entries: whereLines, dropped: 0, join: '\n' }

  // names last: a name the state or any other section already holds is not listed again
  const known = `${opts.stateText ?? ''}\n${render([verbatim, earlier, filesS, failS, commandS, urlS, agentS, whereS], where)}`
  const namesS: Section = {
    title: 'Names in play (identifiers used since the last shrink, most used first)',
    entries: safe(
      () =>
        [...nameScore.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([w]) => w)
          .filter(w => !known.includes(w))
          .slice(0, CAPS.names)
          .map(w => `\`${w}\``),
      [],
    ),
    dropped: 0,
    join: ', ',
    noMore: true,
    dropLast: true,
  }
  commandS.dropLast = true

  // 0.3.0: with the session index, its ranked slice stands in for Files touched and Names in play
  let sliceS: Section | undefined
  if (opts.ranked) {
    const stateLc = (opts.stateText ?? '').toLowerCase()
    const slice = safe(() => indexSlice(opts.ranked!, opts.sliceTokens ?? SLICE_TOKENS, it => heldIn(it, stateLc)), { lines: [], packed: 0, more: 0 })
    sliceS = {
      title: SLICE_TITLE, entries: slice.lines, dropped: slice.more, join: '\n', dropLast: true,
      more: n => `+${n} more items indexed: ask recall with the exact name`,
    }
  }
  const sections = sliceS
    ? [verbatim, earlier, failS, commandS, sliceS, urlS, agentS, whereS]
    : [verbatim, earlier, filesS, failS, commandS, namesS, urlS, agentS, whereS]
  // the slice brings its own room (2 chars per est. token): the rest of the facts keep the budget they had
  const budget = Math.max(0, Math.floor(opts.factsBudgetChars)) + (sliceS ? 2 * (opts.sliceTokens ?? SLICE_TOKENS) : 0)

  // Over budget: drop entries, least precious section first; oldest first, or least used for ranked lists.
  const shrinkOrder = sliceS ? [earlier, urlS, agentS, sliceS, commandS, failS, verbatim] : [namesS, earlier, urlS, agentS, commandS, filesS, failS, verbatim]
  let text = render(sections, where)
  for (const s of shrinkOrder) {
    while (text.length > budget && s.entries.length > 0) {
      if (s.dropLast) s.entries.pop()
      else s.entries.shift()
      s.dropped++
      text = render(sections, where)
    }
  }
  if (text.length <= budget) return text

  // Still over (a tiny budget): keep where to look whole if it fits, cut the body before it.
  const whereText = renderSection(whereS, where)
  const marker = '\n…[facts cut to fit the budget]\n\n'
  const room = budget - whereText.length - marker.length
  if (room > 0) return `${text.slice(0, room)}${marker}${whereText}`
  return text.slice(0, budget)
}
