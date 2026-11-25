// buildFacts: exact facts the summarizer would otherwise have to remember (spec 3.3). Pure and
// deterministic: same input, same output. Every list is oldest first; when a cap or the budget
// is hit, the oldest entries drop and a "+N more" line says where the rest is.

import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { lineNo } from './archive'
import { HANDOFF_HEADER, type Where } from './prompt'

export type FactsOptions = Where & {
  verbatimUserMessages: number
  factsBudgetChars: number
  /** This session's earlier handoff files, oldest first: what earlier resets kept. */
  earlierResets?: readonly string[]
  /** This session's earlier archives, oldest first, as [k, path]: where `#k:n` refs point (0.2.3). */
  earlierArchives?: readonly (readonly [number, string])[]
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

// ---------------------------------------------------------------- helpers

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
const ellipsis = (s: string, cap: number): string => (s.length <= cap ? s : `${s.slice(0, cap - 1)}…`)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

type Outcome = { text?: string; isError: boolean }

export function firstErrorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
  const body = lines.filter(l => !/^(Error: )?Exit code \d+$/.test(l.trim()))
  const flagged = body.find(
    l =>
      !/^\s*Traceback\b/.test(l) &&
      /error|exception|fatal|denied|no such|not found|cannot|can't|failed|refused|invalid/i.test(l),
  )
  return (flagged ?? body[0] ?? lines[0] ?? '(no output)').trim()
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
}

// ---------------------------------------------------------------- sections

type Section = { title: string; entries: string[]; dropped: number; join: string }

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
  if (s.dropped > 0) lines.push(moreLine(s.dropped, where))
  return `${lines.join('\n')}\n${s.entries.join(s.join)}`.trimEnd()
}

function render(sections: Section[], where: Where): string {
  const shown = sections.filter(s => s.entries.length > 0 || s.dropped > 0)
  return [HEADER, ...shown.map(s => renderSection(s, where))].join('\n\n')
}

/** The earlier handoff files: their shared folder once, then the names (saves ~150 chars a file). */
function earlierResetsLine(paths: readonly string[], title = '- Earlier resets of this session (summary and facts each)'): string {
  const dir = paths[0]!.slice(0, paths[0]!.lastIndexOf('/') + 1)
  const shared = dir !== '' && paths.every(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
  return shared ? `${title}, in ${dir}: ${paths.map(p => p.slice(dir.length)).join(', ')}` : `${title}: ${paths.join(', ')}`
}

// ---------------------------------------------------------------- buildFacts

export function buildFacts(messages: readonly SessionMessage[], opts: FactsOptions): string {
  const where: Where = { archivePath: opts.archivePath, transcriptPath: opts.transcriptPath }

  // outcomes, from the call itself or from the tool_result row that answers it
  const outcome = new Map<string, Outcome>()
  for (const m of messages)
    for (const r of m.toolResults ?? []) outcome.set(r.tool_use_id, { text: r.text, isError: r.isError })
  const outcomeOf = (u: ToolUseSummary): Outcome =>
    u.text !== undefined || u.isError ? { text: u.text, isError: u.isError === true } : outcome.get(u.tool_use_id) ?? { isError: false }

  const said: { n: number; text: string }[] = []
  const files = new Recency<{ R: number; W: number; E: number }>()
  const urls = new Recency<true>()
  const failures: string[] = []
  const agents: string[] = []

  messages.forEach((m, i) => {
    const n = lineNo(i)
    if (m.role === 'user') {
      const text = personText(m.text)
      if (text !== undefined) said.push({ n, text })
    }
    for (const u of m.toolUses ?? []) {
      const input = u.input ?? {}
      const path = str(input.file_path) ?? str(input.notebook_path)
      const action =
        u.tool === 'Read' ? 'R' : u.tool === 'Write' ? 'W' : ['Edit', 'MultiEdit', 'NotebookEdit'].includes(u.tool) ? 'E' : undefined
      if (path && action) files.touch(path, () => ({ R: 0, W: 0, E: 0 }))[action]++

      if (u.tool === 'WebFetch' && str(input.url)) urls.touch(input.url as string, () => true)
      if (u.tool === 'Bash' && str(input.command)) for (const url of urlsIn(input.command as string)) urls.touch(url, () => true)

      const out = outcomeOf(u)
      const nonZeroExit = u.tool === 'Bash' && /^(Error: )?Exit code [1-9]\d*/.test(out.text ?? '')
      if (out.isError || nonZeroExit)
        failures.push(`- #${n} ${u.tool}: ${callSummary(u)} → ${ellipsis(firstErrorLine(out.text ?? ''), CAPS.fieldChars)}`)

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
    'Files touched (R read, W written, E edited; counts)',
    files.entries().map(([p, c]) => `- ${p}  ${(['R', 'W', 'E'] as const).filter(k => c[k] > 0).map(k => `${k}${c[k]}`).join(' ')}`),
    CAPS.files,
  )
  const failS = make('Failed commands and errors', failures, CAPS.failures)
  const urlS = make('URLs fetched', urls.entries().map(([u]) => `- ${u}`), CAPS.urls)
  const agentS = make('Agents spawned', agents, CAPS.agents)

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
  if (whereLines.length === 0) whereLines.push('- No archive or transcript was kept for this session.')
  const whereS: Section = { title: 'Where to look', entries: whereLines, dropped: 0, join: '\n' }

  const sections = [verbatim, earlier, filesS, failS, urlS, agentS, whereS]
  const budget = Math.max(0, Math.floor(opts.factsBudgetChars))

  // Over budget: drop oldest entries, least precious section first.
  const shrinkOrder = [earlier, urlS, agentS, filesS, failS, verbatim]
  let text = render(sections, where)
  for (const s of shrinkOrder) {
    while (text.length > budget && s.entries.length > 0) {
      s.entries.shift()
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
