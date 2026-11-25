// Units: the shrunk-away conversation as searchable pieces (design 4.1). Pure.
//
// One unit per user message with words, per assistant text, and per tool call (call + result).
// `ref` is "<session>-<k>#<n>" (n = the archive line, the 1-based message index); a tool call
// adds ".<j>", its place among the message's calls.

import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { formatInput, lineNo } from './archive'
import { personText } from './facts'
import { HANDOFF_HEADER } from './prompt'

export type SourceKind = 'user' | 'tool' | 'assistant' | 'handoff'

export type Unit = {
  ref: string
  session: string
  k: number
  n: number
  /** A tool call whose result came in a later message: that message's archive line (0.2.4). */
  resultN?: number
  kind: SourceKind
  tool?: string
  isError?: boolean
  toolUseId?: string
  text: string
  entities: string[]
}

export const RESULT_CHARS = 8000
const MAX_ENTITIES = 50
const SHARD_BYTES = 3 * 1024 * 1024

/** The engine's own summary row of an earlier built-in compaction. */
const ENGINE_SUMMARY = 'This session is being continued from a previous conversation'

const URL_RE = /https?:\/\/[^\s'"`<>()[\]{}|\\^]+/g
const PATH_RE = /(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)*|\b[\w.-]+\/[\w.@/-]*[\w@-]/g
const FILE_RE = /\b[\w-]+\.(?:py|ts|tsx|js|mjs|json|jsonl|md|txt|sh|toml|ya?ml|sql|css|html|rs|go|java|rb|php|c|h|cpp|csv|log)\b/g
const ERROR_RE = /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/g

/** File paths, URLs and error names in a text, each once, in order of appearance. */
export function entitiesOf(text: string): string[] {
  const seen = new Set<string>()
  const add = (s: string) => {
    if (s.length > 1 && seen.size < MAX_ENTITIES) seen.add(s)
  }
  for (const u of text.match(URL_RE) ?? []) add(u.replace(/[.,;:!?]+$/, ''))
  const rest = text.replace(URL_RE, ' ')
  for (const p of rest.match(PATH_RE) ?? []) add(p.replace(/[.,;:]+$/, ''))
  for (const f of rest.match(FILE_RE) ?? []) add(f)
  for (const e of rest.match(ERROR_RE) ?? []) add(e)
  return [...seen]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Paths and URLs the call names in its input, ahead of what its text mentions. */
function inputEntities(u: ToolUseSummary): string[] {
  const i = u.input ?? {}
  return [str(i.file_path), str(i.notebook_path), str(i.path), str(i.url)].filter((s): s is string => s !== undefined)
}

/** The recall tool's answers are summaries of the archive, so they rank as one, below raw tool output. */
const isRecall = (tool: string | undefined): boolean => tool !== undefined && /(?:^|__)recall$/.test(tool)

export function buildUnits(messages: readonly SessionMessage[], at: { session: string; k: number }): Unit[] {
  const rows = new Map<string, { text: string; isError: boolean; n: number }>()
  messages.forEach((m, i) => {
    for (const r of m.toolResults ?? []) if (!rows.has(r.tool_use_id)) rows.set(r.tool_use_id, { text: r.text, isError: r.isError, n: lineNo(i) })
  })

  const units: Unit[] = []
  const unit = (n: number, suffix: string, kind: SourceKind, text: string, extra: Partial<Unit> = {}, first: string[] = []) => {
    const entities = [...new Set([...first, ...entitiesOf(text)])].slice(0, MAX_ENTITIES)
    units.push({ ref: `${at.session}-${at.k}#${n}${suffix}`, session: at.session, k: at.k, n, kind, ...extra, text, entities })
  }

  messages.forEach((m, i) => {
    const n = lineNo(i)
    if (m.role === 'user') {
      const stripped = m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
      if (stripped.startsWith(HANDOFF_HEADER) || stripped.startsWith(ENGINE_SUMMARY)) unit(n, '', 'handoff', stripped)
      else {
        const said = personText(m.text)
        if (said !== undefined) unit(n, '', 'user', said)
      }
      return
    }
    if (m.text.trim() !== '') unit(n, '', 'assistant', m.text.trim())
    ;(m.toolUses ?? []).forEach((u, j) => {
      const row = rows.get(u.tool_use_id)
      const result = u.text ?? row?.text
      const isError = u.isError === true || (u.text === undefined && row?.isError === true)
      const shown =
        result === undefined
          ? ''
          : result.length > RESULT_CHARS
            ? `\n${result.slice(0, RESULT_CHARS)}…[+${result.length - RESULT_CHARS} chars; full: archive #${n}]`
            : `\n${result}`
      unit(
        n,
        `.${j + 1}`,
        isRecall(u.tool) ? 'handoff' : 'tool',
        `${u.tool}: ${formatInput(u)}${shown}`,
        {
          tool: u.tool,
          toolUseId: u.tool_use_id,
          ...(u.text === undefined && row !== undefined ? { resultN: row.n } : {}),
          ...(isError ? { isError: true as const } : {}),
        },
        inputEntities(u),
      )
    })
  })
  return units
}

/** Units as JSONL, split so no shard is over `maxBytes` of UTF-8 (one oversized line stands alone). */
export function serializeUnits(units: readonly Unit[], maxBytes: number = SHARD_BYTES): string[] {
  const enc = new TextEncoder()
  const shards: string[] = []
  let cur = ''
  let size = 0
  for (const u of units) {
    const line = `${JSON.stringify(u)}\n`
    const bytes = enc.encode(line).length
    if (size > 0 && size + bytes > maxBytes) {
      shards.push(cur)
      cur = ''
      size = 0
    }
    cur += line
    size += bytes
  }
  if (cur !== '') shards.push(cur)
  return shards
}

const isUnit = (v: unknown): v is Unit => {
  const u = v as Partial<Unit> | null
  return !!u && typeof u.ref === 'string' && typeof u.text === 'string' && typeof u.n === 'number' && Array.isArray(u.entities)
}

/** The units in a JSONL shard; lines that are not units are skipped. */
export function parseUnits(jsonl: string): Unit[] {
  const out: Unit[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (isUnit(v)) out.push(v.kind === 'tool' && isRecall(v.tool) ? { ...v, kind: 'handoff' } : v) // shards written before 0.2.1
    } catch {
      // not a unit
    }
  }
  return out
}
