// The session's item index (0.3.0): every exact item the session has used (paths, file names, ids,
// versions, code names), each Bash command that ran, and each of the person's prompts, merged at each shrink into
// `handoffs/items/<sid8>.jsonl`. The handoff's ranked slice and recall's exact lookup read it. Pure: register.ts
// does the reading and writing.
//
//   {"v":1,"k":12,"pos":4810,"seen":["toolu_…",…]}                         first line: the head
//   {"item":"~/a/b.ts","kind":"path","typed":4,"shown":9,"win":1,"marks":"RE","lastSeg":12,"lastPos":4790,"refs":["1:40","12:3"]}
//
// `itemsOf` keeps the regex classes of the offline tool that fitted the ranker (JS `\w` is ASCII there).

import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { personText, isShrinkCommand } from './facts'
import { HANDOFF_HEADER } from './prompt'
import { escapeRe, squash, stringsOf } from './util'

export type ItemKind = 'path' | 'file' | 'hex' | 'ver' | 'snake' | 'camel'
export const ITEM_KINDS: readonly ItemKind[] = ['path', 'file', 'hex', 'ver', 'snake', 'camel']
export type EntryKind = ItemKind | 'command' | 'prompt'

export type IndexEntry = {
  item: string
  kind: EntryKind
  /** times the model wrote it (its text or a tool input) */
  typed: number
  /** times it was shown to the model (results, the person's text) */
  shown: number
  /** times typed in the latest merged window */
  win: number
  /** R W E S: read, written, edited, changed by a shell command (paths only) */
  marks: string
  lastSeg: number
  /** position in the whole session (messages merged so far), for recency */
  lastPos: number
  /** `${k}:${n}` archive refs: the first, then the newest */
  refs: string[]
  /** a command's first result line */
  result?: string
}

export type IndexHead = { v: 1; k: number; pos: number; seen: string[] }
export type SessionIndex = { head: IndexHead; entries: Map<string, IndexEntry> }

export const REFS_KEPT = 8
export const SEEN_KEPT = 400
export const COMMANDS_KEPT = 1500
export const PROMPTS_KEPT = 500
export const COMMAND_CAP = 300
export const RESULT_LINE_CAP = 120
export const PROMPT_CAP = 200

export const emptyIndex = (): SessionIndex => ({ head: { v: 1, k: 0, pos: 0, seen: [] }, entries: new Map() })

const PLAIN_REF = /^(\d+):(\d+)$/

/**
 * A fork's first index: the parent session's, with the parent's own `k:n` refs qualified as `sid8-k#n` (the form
 * 0.2.11 handoffs cite another session's archives in), and every entry placed before the fork's first shrink.
 * Refs already qualified (a fork of a fork) are kept. The parent's index is not changed.
 */
export function seedFromParent(parent: SessionIndex, parentSid8: string): SessionIndex {
  const entries = new Map<string, IndexEntry>()
  for (const [key, e] of parent.entries)
    entries.set(key, {
      ...e,
      win: 0,
      lastSeg: 0,
      refs: e.refs.map(r => r.replace(PLAIN_REF, (_, k: string, n: string) => `${parentSid8}-${k}#${n}`)),
    })
  return { head: { ...parent.head, k: 0, seen: [...parent.head.seen] }, entries }
}

// ---------------------------------------------------------------- items

const ITEM = new RegExp(
  String.raw`(?<path>(?<![\w/~.])(?:~|\.\.?)?/?(?:[\w.@+-]+/)+[\w.@+-]+)` +
    String.raw`|(?<file>\b[\w-]+\.(?:py|ts|tsx|js|mjs|json|jsonl|md|txt|sh|toml|yaml|yml|log|html|css|rs|go|c|h|cpp)\b)` +
    String.raw`|(?<hex>\b(?=[0-9a-f-]*\d)(?=[0-9a-f-]*[a-f])[0-9a-f]{7,40}(?:-[0-9a-f]{4,12})*\b)` +
    String.raw`|(?<ver>\b\d+\.\d+\.\d+\b)` +
    String.raw`|(?<snake>\b[A-Za-z][A-Za-z0-9]*(?:_+[A-Za-z0-9]+)+\b)` +
    String.raw`|(?<camel>\b[a-z]+(?:[A-Z][a-z0-9]+)+\b)`,
  'g',
)
// always in context (system prompt, memory index, CLAUDE.md, the mod's own recall tool): never worth a slot
const ENV = /^(\/tmp\/claude-\d+\/|\/dev\/|\/bin\/|\/usr\/|\/sys\/|\/proc\/)|^(CLAUDE|MEMORY)\.md$|^--(help|version)$|memory\/[\w.-]+\.md$|^mcp__shrink__recall$/
const TRAIL = /[.,:;)-]+$/


/** The text with the home folder written as `~` (as the handoff writes it). */
export function normHome(text: string, home: string | undefined): string {
  return home && home.length > 1 ? text.replace(new RegExp(escapeRe(home.replace(/\/+$/, '')), 'g'), '~') : text
}

/** The exact items in a text, each with its kind, first seen first. */
export function itemsOf(text: string, home?: string): { item: string; kind: ItemKind }[] {
  const out = new Map<string, ItemKind>()
  for (const m of normHome(text, home).matchAll(ITEM)) {
    const kind = (ITEM_KINDS.find(k => m.groups?.[k] !== undefined) ?? 'snake') as ItemKind
    const t = m[0].replace(TRAIL, '')
    if (kind === 'path' && (t.length < 8 || !/[A-Za-z]/.test(t) || (!t.includes('.') && t.split('/').length - 1 < 2))) continue
    if ((kind === 'snake' || kind === 'camel') && t.length < 6) continue
    if (ENV.test(t) || out.has(t)) continue
    out.set(t, kind)
  }
  return [...out].map(([item, kind]) => ({ item, kind }))
}

// ---------------------------------------------------------------- merge

const cut = (s: string, cap: number): string => (s.length <= cap ? s : `${s.slice(0, cap - 1)}…`)


/** A key that names the same message in the next window (kept messages come back word for word). */
export function messageKey(m: SessionMessage): string {
  const id = m.toolUses?.[0]?.tool_use_id ?? m.toolResults?.[0]?.tool_use_id
  if (id) return `${m.role}:${id}`
  if (m.uuid) return `u:${m.uuid}`
  let h = 2166136261
  for (let i = 0; i < m.text.length; i++) h = Math.imul(h ^ m.text.charCodeAt(i), 16777619)
  return `${m.role}:${m.text.length}:${(h >>> 0).toString(16)}`
}

const PATH_ACTION: Record<string, string> = { Read: 'R', Write: 'W', Edit: 'E', MultiEdit: 'E', NotebookEdit: 'E' }

export type MergeOptions = {
  /** this shrink's number */
  k: number
  /** the home folder, written as `~` */
  home?: string
  /** the archive line of message i (default i + 1) */
  lineOf?: (i: number) => number
}

/**
 * The index after this window: counts and refs added for each message not merged before. A copy of an earlier
 * handoff (the window's first message after a shrink) is skipped: its items were counted where they were used.
 */
export function mergeIndex(prev: SessionIndex, window: readonly SessionMessage[], o: MergeOptions): SessionIndex {
  const entries = new Map<string, IndexEntry>()
  for (const [key, e] of prev.entries) entries.set(key, { ...e, win: 0, refs: [...e.refs] })
  const seen = new Set(prev.head.seen)
  const lineOf = o.lineOf ?? ((i: number) => i + 1)
  let pos = prev.head.pos

  const results = new Map<string, { text: string; isError: boolean }>()
  for (const m of window) for (const r of m.toolResults ?? []) results.set(r.tool_use_id, { text: r.text, isError: r.isError })
  const outcomeOf = (u: ToolUseSummary) =>
    results.get(u.tool_use_id) ?? (u.text !== undefined || u.isError ? { text: u.text ?? '', isError: u.isError === true } : undefined)

  const touch = (item: string, kind: EntryKind, ref: string): IndexEntry => {
    let e = entries.get(item)
    if (!e) {
      e = { item, kind, typed: 0, shown: 0, win: 0, marks: '', lastSeg: o.k, lastPos: pos, refs: [ref] }
      entries.set(item, e)
    }
    e.lastSeg = o.k
    e.lastPos = pos
    if (e.refs[e.refs.length - 1] !== ref) {
      e.refs.push(ref)
      if (e.refs.length > REFS_KEPT + 1) e.refs.splice(1, e.refs.length - REFS_KEPT - 1)
    }
    return e
  }
  const add = (text: string, typed: boolean, ref: string) => {
    for (const { item, kind } of itemsOf(text, o.home)) {
      const e = touch(item, kind, ref)
      if (typed) {
        e.typed++
        e.win++
      } else e.shown++
    }
  }

  const keys: string[] = []
  window.forEach((m, i) => {
    const key = messageKey(m)
    keys.push(key)
    if (seen.has(key)) return
    if (i === 0 && m.role === 'user' && m.text.trimStart().startsWith(HANDOFF_HEADER)) return
    pos++
    const ref = `${o.k}:${lineOf(i)}`
    if (m.role === 'assistant') {
      add(m.text, true, ref)
      for (const u of m.toolUses ?? []) {
        add(stringsOf(u.input), true, ref)
        if (u.tool.includes('__')) {
          const e = touch(u.tool, 'snake', ref)
          e.typed++
          e.win++
        }
        const out = outcomeOf(u)
        if (out && !results.has(u.tool_use_id)) add(out.text, false, ref)
        const path = typeof u.input?.file_path === 'string' ? normHome(u.input.file_path, o.home) : undefined
        const act = PATH_ACTION[u.tool]
        if (path && act && out?.isError !== true) {
          const e = entries.get(path)
          if (e && !e.marks.includes(act)) e.marks = [...new Set(e.marks + act)].sort((a, b) => 'RWES'.indexOf(a) - 'RWES'.indexOf(b)).join('')
        }
        const cmd = u.tool === 'Bash' && typeof u.input?.command === 'string' ? cut(squash(normHome(u.input.command, o.home)), COMMAND_CAP) : ''
        if (cmd && out && !out.isError) {
          const e = touch(cmd, 'command', ref)
          e.typed++
          const line = out.text.split('\n').map(l => l.trim()).find(l => l !== '')
          if (line) e.result = cut(normHome(line, o.home), RESULT_LINE_CAP)
        }
      }
    } else {
      add(m.text, false, ref)
      for (const r of m.toolResults ?? []) add(r.text, false, ref)
      const said = personText(m.text)
      if (said !== undefined && !isShrinkCommand(m.text) && !(m.toolResults?.length)) {
        const e = touch(cut(squash(normHome(said, o.home)), PROMPT_CAP), 'prompt', ref)
        e.shown++
      }
    }
  })

  capKind(entries, 'command', COMMANDS_KEPT)
  capKind(entries, 'prompt', PROMPTS_KEPT)
  return { head: { v: 1, k: o.k, pos, seen: keys.slice(-SEEN_KEPT) }, entries }
}

function capKind(entries: Map<string, IndexEntry>, kind: EntryKind, keep: number) {
  const of = [...entries.values()].filter(e => e.kind === kind)
  if (of.length <= keep) return
  of.sort((a, b) => b.lastPos - a.lastPos)
  for (const e of of.slice(keep)) entries.delete(e.item)
}

// ---------------------------------------------------------------- file

export function serializeIndex(idx: SessionIndex): string {
  const lines = [JSON.stringify(idx.head)]
  for (const e of idx.entries.values()) lines.push(JSON.stringify(e))
  return `${lines.join('\n')}\n`
}

const isEntry = (v: unknown): v is IndexEntry => {
  const e = v as IndexEntry
  return (
    typeof e === 'object' && e !== null && typeof e.item === 'string' && typeof e.kind === 'string' &&
    typeof e.typed === 'number' && typeof e.shown === 'number' && typeof e.lastSeg === 'number' &&
    typeof e.lastPos === 'number' && Array.isArray(e.refs)
  )
}

/** Tolerant: a bad line is skipped; a missing or bad head gives an empty head. */
export function parseIndex(text: string | undefined): SessionIndex {
  const idx = emptyIndex()
  if (!text) return idx
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    const h = v as IndexHead
    if (i === 0 && h && h.v === 1 && typeof h.k === 'number' && typeof h.pos === 'number') {
      idx.head = { v: 1, k: h.k, pos: h.pos, seen: Array.isArray(h.seen) ? h.seen.filter(s => typeof s === 'string') : [] }
      continue
    }
    if (isEntry(v)) idx.entries.set(v.item, { ...v, win: typeof v.win === 'number' ? v.win : 0, marks: typeof v.marks === 'string' ? v.marks : '' })
  }
  return idx
}

// ---------------------------------------------------------------- ranking features

/** The ranker's features for an item entry at shrink k, in `RANK_WEIGHTS` order. */
export function features(e: IndexEntry, k: number, pos: number): number[] {
  const age = Math.max(0, k - e.lastSeg)
  return [
    1,
    Math.log1p(e.typed),
    Math.log1p(e.shown),
    Math.min(age, 8) / 8,
    age === 0 ? 1 : 0,
    Math.log1p(e.win),
    0,
    e.item.length / 40,
    (pos - e.lastPos) / Math.max(pos, 1),
    ...ITEM_KINDS.map(x => (e.kind === x ? 1 : 0)),
  ]
}

/**
 * The fitted ranker (0.3.0): logistic weights over `features`, fitted once offline. On held-out sessions it put
 * more of the items a session later needed into a 5,000-token slice than ranking typed items first did.
 */
export const RANK_WEIGHTS: readonly number[] = [
  -0.0786, 1.1543, -0.3837, -1.4235, 0.2941, 0.3862, 0.0, -0.478, -0.0033, 0.4647, 0.7259, -0.9431, -0.6094, 0.1521, 0.1311,
]

/** The index's exact items (no commands or prompts), best first by the fitted ranker; ties keep the newer first. */
export function rankEntries(idx: SessionIndex): IndexEntry[] {
  const items = [...idx.entries.values()].filter(e => (ITEM_KINDS as readonly string[]).includes(e.kind))
  const score = new Map(items.map(e => [e, features(e, idx.head.k, idx.head.pos).reduce((s, x, i) => s + x * (RANK_WEIGHTS[i] ?? 0), 0)]))
  return items.sort((a, b) => score.get(b)! - score.get(a)! || b.lastPos - a.lastPos)
}
