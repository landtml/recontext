// The shrink mod's hooks (design 3, 5). The pure parts live in units, search, digest, handoff,
// reader, facts and archive. Rule: the mod never makes a compaction fail. The shrink falls back to
// a code-only handoff when Haiku fails, and to the engine's own compaction when anything throws.

import type {
  EngineInterface,
  ModelEffort,
  ModelUsage,
  PluginOptions,
  Register,
  SessionCompactInput,
  SessionCompacted,
  SessionCompactResult,
  SessionMessage,
} from 'claude-code'
import { buildArchive } from './archive'
import { DEFAULT_BUDGET_TOKENS, IDENTITY_RESERVE_TOKENS, estimateRequest, estimateTokens } from './budget'
import { digestParts, dropLines, previousStateOf, renderDigest, type DigestLine, type PartNote } from './digest'
import { missingSections } from './prompt'
import { codeNote, fitNote, partNote, planShards } from './shard'
import { archiveEmptyLines, archiveLineCount, checkRefs, qualifyRefs } from './refs'
import { buildFacts } from './facts'
import { MAP_SYSTEM, STATE_SYSTEM, buildHandoff, mapPrompt, pickTail, statePrompt, tailSize, trimTail } from './handoff'
import { READER_SYSTEM, checkDraft, formatRecall, namedNote, parseDraft, readerPrompt, renderEvidence, type RecallOutcome } from './reader'
import { MOD_VERSION, SHRINK_HELP, parseShrinkArgs } from './command'
import { expand, RANKED_HITS, search } from './search'
import { PANE_ID, PANE_TITLE, fillNow, recordFill, recordRecall, recordShrink, registerUi } from './ui'
import { buildUnits, parseUnits, serializeUnits, type Unit } from './units'
import { dirname, expandPath } from './paths'
import { TAIL_BYTES, queuedMessages, queuedSection, unansweredQueued, type Queued } from './queued'

type Config = {
  mode: 'haiku' | 'code'
  shrinkModel: string
  handoffDir: string
  digestChars: number
  haikuBudgetTokens: number
  stateEffort: ModelEffort
  mapEffort: ModelEffort
  recallEffort: ModelEffort
  factsBudgetChars: number
  tailChars: number
  recallScope: 'session' | 'project'
  thresholdWarnAbove: number
}

const RECOMMENDED_WINDOW = 200000
const HAIKU_TIMEOUT_MS = 60000
/** A state written at `high` effort or above thinks longer (design 3.4). */
const STATE_TIMEOUT_HIGH_MS = 90000
/** Room for thinking as well as the state, which the prompt keeps to about 1,000 words. */
const STATE_MAX_TOKENS = 8000
const MAP_MAX_TOKENS = 4000
const MAP_CONCURRENCY = 3
const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const VERBATIM_USER_MESSAGES = 5

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
const text = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback)
const effort = (v: unknown, fallback: ModelEffort): ModelEffort => (EFFORTS.includes(v as ModelEffort) ? (v as ModelEffort) : fallback)

export function readConfig(o: PluginOptions): Config {
  return {
    mode: o.mode === 'code' ? 'code' : 'haiku',
    shrinkModel: text(o.shrinkModel, 'haiku'),
    handoffDir: typeof o.handoffDir === 'string' ? o.handoffDir.trim() : '',
    digestChars: num(o.digestChars, 0),
    haikuBudgetTokens: num(o.haikuBudgetTokens, DEFAULT_BUDGET_TOKENS) || DEFAULT_BUDGET_TOKENS,
    stateEffort: effort(o.stateEffort, 'medium'),
    mapEffort: effort(o.mapEffort, 'medium'),
    recallEffort: effort(o.recallEffort, 'medium'),
    factsBudgetChars: num(o.factsBudgetChars, 14000),
    tailChars: num(o.tailChars, 24000),
    recallScope: o.recallScope === 'session' ? 'session' : 'project',
    thresholdWarnAbove: num(o.thresholdWarnAbove, 200000),
  }
}

/** An error's message, less the engine's `shrink: ` prefix (every toast already carries it). */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/^shrink: /, '')
const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function toast($: EngineInterface, message: string): void {
  try {
    $.ui.toast(message)
  } catch {
    // a toast is a courtesy
  }
}

/** A trace line to Claude Code's own debug log (shown with `claude --debug`). Never throws. */
function debug($: EngineInterface, message: string): void {
  try {
    $.ui.log(message, { to: 'debug' })
  } catch {
    // tracing only
  }
}

/** Sum of two usages (a recall can make two Haiku calls). */
function addUsage(a: ModelUsage | undefined, b: ModelUsage | undefined): ModelUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  }
}

/** The home folder: HOME, else USERPROFILE (Windows). */
async function homeOf($: EngineInterface): Promise<string | undefined> {
  return ((await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))) || undefined
}

/** A configured folder with `~` expanded and trailing separators dropped; undefined when `~` has no home. */
async function expandDir($: EngineInterface, p: string): Promise<string | undefined> {
  return expandPath(p, p.startsWith('~') ? { HOME: await homeOf($) } : {})
}

async function resolveDir($: EngineInterface, cfg: Config, transcriptPath: string): Promise<string | undefined> {
  if (cfg.handoffDir !== '') return expandDir($, cfg.handoffDir)
  return transcriptPath !== '' ? `${dirname(transcriptPath)}/handoffs` : undefined
}


const EARLIER_SHOWN = 10

/** This session's next shrink number (past its handoff files and archives) and its earlier handoffs. */
async function scanShrinks(
  $: EngineInterface,
  dir: string,
  sid8: string,
): Promise<{ k: number; earlier: string[]; archives: [number, string][] }> {
  const [top, archive] = await Promise.all([$.fs.list(dir).catch(() => []), $.fs.list(`${dir}/archive`).catch(() => [])])
  const sid = escapeRe(sid8)
  const handoffRe = new RegExp(`^session-handoff_\\d{4}-\\d{2}-\\d{2}_${sid}-(\\d+)\\.md$`)
  const archiveRe = new RegExp(`^\\d{4}-\\d{2}-\\d{2}_${sid}-(\\d+)\\.txt$`)
  let k = 0
  const handoffs: { k: number; path: string }[] = []
  for (const entry of top) {
    const m = handoffRe.exec(entry.name)
    if (!m) continue
    k = Math.max(k, Number(m[1]))
    handoffs.push({ k: Number(m[1]), path: `${dir}/${entry.name}` })
  }
  const archives: [number, string][] = []
  for (const entry of archive) {
    const m = archiveRe.exec(entry.name)
    if (!m) continue
    k = Math.max(k, Number(m[1]))
    archives.push([Number(m[1]), `${dir}/archive/${entry.name}`])
  }
  handoffs.sort((a, b) => a.k - b.k)
  archives.sort((a, b) => a[0] - b[0])
  return { k: k + 1, earlier: handoffs.slice(-EARLIER_SHOWN).map(h => h.path), archives }
}

/** The context size now: the last reading the bar recorded (session.measure), else the engine's live one. */
async function contextNow($: EngineInterface): Promise<{ tokens?: number; threshold?: number }> {
  const f = await fillNow($).catch(() => ({}) as { tokens?: number; threshold?: number })
  if (f.tokens !== undefined) return f
  const live = await $.session.usage().catch(() => undefined)
  return { tokens: live?.context.tokens, threshold: f.threshold }
}

type Asked = { text?: string; usage?: ModelUsage; why?: string; ms?: number; est: number; effort: ModelEffort }
type AskOpts = { maxTokens: number; effort: ModelEffort; timeoutMs?: number }

/** One Haiku call; never rejects. `est`: its prompt's estimated tokens (design 3.2). */
async function ask($: EngineInterface, cfg: Config, system: string, prompt: string, o: AskOpts): Promise<Asked> {
  const t0 = await $.clock.now().catch(() => 0)
  const took = async () => (await $.clock.now().catch(() => t0)) - t0
  const base = { est: estimateRequest(system, prompt), effort: o.effort }
  try {
    const r = await $.model.complete({ model: cfg.shrinkModel, system, prompt, maxTokens: o.maxTokens, effort: o.effort, timeoutMs: o.timeoutMs ?? HAIKU_TIMEOUT_MS })
    if (r.isAnswered && r.text.trim() !== '') return { ...base, text: r.text, usage: r.usage, ms: await took() }
    return { ...base, usage: r.usage, why: r.isAnswered ? 'empty reply' : r.reason, ms: await took() }
  } catch (err) {
    return { ...base, why: errText(err), ms: await took() }
  }
}

/** Tokens a call's prompt really took (no prompt cache is used, but count it if the engine reports any). */
const promptTokens = (u: ModelUsage | undefined): number | undefined =>
  u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : undefined

/** One Haiku call for the debug trace: what was estimated next to what was billed. */
type CallLog = { role: 'state' | 'retry' | 'map'; est: number; in?: number; out?: number; ms?: number; effort: ModelEffort; why?: string }
const callLog = (role: CallLog['role'], a: Asked): CallLog => ({
  role,
  est: a.est,
  in: promptTokens(a.usage),
  out: a.usage?.output_tokens,
  ms: a.ms,
  effort: a.effort,
  ...(a.why ? { why: a.why } : {}),
})

/** Runs `fn` over `items`, at most `limit` at once, results in order. `fn` must not reject. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return out
}

type StateRun = {
  text?: string
  why?: string
  usage?: ModelUsage
  ms: number
  calls: CallLog[]
  /** Everything Haiku read across the calls, for the ref check's 0.2.5 rule. */
  read: string
  /** The digest uncut, and how many lines a `digestChars` override dropped. */
  digestChars: number
  digestDropped: number
  /** The final state request's estimate (one call, or the merge). */
  estTokens: number
  sharded?: { slices: number; newestLines: number; olderLines: number; dropped: number; mapFailed: number }
}

const HEADINGS_NEEDED = ['Goal', 'Current task and next step']

/**
 * The state call with its guard (design 3.4): a reply missing headings (cut off), or a call at `high` or above
 * that timed out, gets one retry at `medium`. The attempt missing fewer headings stands, if it has the goal and
 * the current task; otherwise there is no state and the handoff is code-only.
 */
async function stateCall($: EngineInterface, cfg: Config, prompt: string, calls: CallLog[]): Promise<Asked> {
  const high = cfg.stateEffort !== 'low' && cfg.stateEffort !== 'medium'
  const first = await ask($, cfg, STATE_SYSTEM, prompt, { maxTokens: STATE_MAX_TOKENS, effort: cfg.stateEffort, timeoutMs: high ? STATE_TIMEOUT_HIGH_MS : HAIKU_TIMEOUT_MS })
  calls.push(callLog('state', first))
  const missing = (a: Asked) => (a.text ? missingSections(a.text) : [...HEADINGS_NEEDED])
  if (first.text && missing(first).length === 0) return first
  if (!first.text && !(high && first.why === 'aborted')) return first
  const second = await ask($, cfg, STATE_SYSTEM, prompt, { maxTokens: STATE_MAX_TOKENS, effort: 'medium' })
  calls.push(callLog('retry', second))
  const usage = addUsage(first.usage, second.usage)
  const ms = (first.ms ?? 0) + (second.ms ?? 0)
  const best = [second, first].filter(a => a.text).sort((a, b) => missing(a).length - missing(b).length)[0]
  if (best && !HEADINGS_NEEDED.some(h => missing(best).includes(h))) return { ...best, usage, ms }
  const why = best ? `state cut off (missing ${missing(best).join(', ')})` : (second.why ?? first.why)
  return { ...second, text: undefined, why, usage, ms }
}

/**
 * The state of work (design 3.3): one call when the digest fits the budget, else map workers take notes on the
 * older slices and the state call merges them with the newest lines, read raw. Never rejects.
 */
async function writeState($: EngineInterface, cfg: Config, messages: readonly SessionMessage[], prevK: number, focus?: string): Promise<StateRun> {
  const { previous, lines: all } = digestParts(messages, prevK)
  let lines: DigestLine[] = all
  let digestDropped = 0
  const full = renderDigest(previous, all)
  if (cfg.digestChars > 0 && full.length > cfg.digestChars) {
    const r = dropLines(all, full.length - cfg.digestChars)
    lines = r.kept
    digestDropped = r.dropped
  }
  const calls: CallLog[] = []
  const base = { digestChars: full.length, digestDropped, calls }
  const digest = renderDigest(previous, lines)
  const single = statePrompt(digest, focus)
  if (cfg.mode !== 'haiku') return { ...base, why: 'mode code', ms: 0, read: digest, estTokens: estimateRequest(STATE_SYSTEM, single) }
  if (estimateRequest(STATE_SYSTEM, single) <= cfg.haikuBudgetTokens) {
    const a = await stateCall($, cfg, single, calls)
    return { ...base, text: a.text, why: a.why, usage: a.usage, ms: a.ms ?? 0, read: digest, estTokens: a.est }
  }

  const plan = planShards(lines, {
    budget: cfg.haikuBudgetTokens,
    mergeFixed: estimateRequest(STATE_SYSTEM, statePrompt(renderDigest(previous, [], [{ part: 6, of: 6, first: 99999, last: 99999, text: '' }]), focus)),
    sliceFixed: estimateRequest(MAP_SYSTEM, mapPrompt('', 6, 6, 99999, 99999, focus)),
  })
  const of = plan.slices.length
  const mapStart = await $.clock.now().catch(() => 0)
  const mapped = await pool(plan.slices, MAP_CONCURRENCY, (slice, i) =>
    ask($, cfg, MAP_SYSTEM, mapPrompt(slice.map(l => l.text).join('\n'), i + 1, of, slice[0]!.n, slice[slice.length - 1]!.n, focus), {
      maxTokens: MAP_MAX_TOKENS,
      effort: cfg.mapEffort,
    }),
  )
  const mapMs = (await $.clock.now().catch(() => mapStart)) - mapStart
  let usage: ModelUsage | undefined
  const notes: PartNote[] = mapped.map((a, i) => {
    calls.push(callLog('map', a))
    usage = addUsage(usage, a.usage)
    const slice = plan.slices[i]!
    return partNote(slice, i + 1, of, a.text ? fitNote(a.text) : codeNote(slice, a.why ?? 'no reply'))
  })
  const mergeDigest = renderDigest(previous, plan.newest, notes)
  const a = await stateCall($, cfg, statePrompt(mergeDigest, focus), calls)
  return {
    ...base,
    text: a.text,
    why: a.why,
    usage: addUsage(usage, a.usage),
    ms: mapMs + (a.ms ?? 0),
    read: [mergeDigest, ...plan.slices.map(sl => sl.map(l => l.text).join('\n'))].join('\n'),
    estTokens: a.est,
    sharded: {
      slices: of,
      newestLines: plan.newest.length,
      olderLines: plan.slices.reduce((s, sl) => s + sl.length, 0),
      dropped: plan.dropped,
      mapFailed: mapped.filter(m => !m.text).length,
    },
  }
}

const withoutHandle = ({ handle: _handle, ...m }: SessionMessage): SessionMessage => m

/** The recall tool's full name, as the engine registered it. */
let recallTool: string | undefined

/** Messages queued mid-turn that the model has not seen (design 3.7): `queued_command` rows at the transcript's
 *  end with no assistant row after them. One that a recent handed user message already holds is left out. */
async function readQueued($: EngineInterface, path: string, handed: readonly SessionMessage[]): Promise<Queued[]> {
  const { size } = await $.fs.stat(path)
  const offset = Math.max(0, size - TAIL_BYTES)
  const read = await $.fs.read(path, { offset, length: size - offset })
  if (typeof read !== 'string') return []
  const tail = offset > 0 ? read.slice(read.indexOf('\n') + 1) : read
  const recent = handed.slice(-8).flatMap(m => (m.role === 'user' ? [m.text] : []))
  return unansweredQueued(tail).filter(q => q.text === '' || !recent.some(t => t.includes(q.text)))
}

async function shrink($: EngineInterface, cfg: Config, e: SessionCompactInput, startedAt: number): Promise<SessionCompacted> {
  const start = pickTail(e.messages, cfg.tailChars)
  if (start < 0) throw new Error('no valid tail to keep')

  const sid = await $.session.id()
  const sid8 = sid.slice(0, 8)
  const transcriptPath = (await $.session.info().catch(() => undefined))?.transcriptPath ?? ''
  const now = await $.clock.now()
  const date = ymd(now)
  const dir = await resolveDir($, cfg, transcriptPath)
  const { k, earlier, archives } = dir ? await scanShrinks($, dir, sid8) : { k: 1, earlier: [], archives: [] }
  const name = `${date}_${sid8}-${k}`
  const failures: string[] = []
  const before = (await contextNow($)).tokens

  // 0. messages queued mid-turn (0.2.9): carried at the top of the handoff and appended, as user messages, to what
  // the archive, index, digest and facts read; the tail stays the engine's own messages
  // a failed read goes to the debug log, not a problem: no file goes unwritten and the shrink is as in 0.2.8
  let queued: Queued[] = []
  let queuedError: string | undefined
  if (transcriptPath)
    try {
      queued = await readQueued($, transcriptPath, e.messages)
    } catch (err) {
      queuedError = errText(err)
    }
  const msgs: readonly SessionMessage[] = queued.length ? [...e.messages, ...queuedMessages(queued)] : e.messages

  // 1-2. index shards and archive (written first, so the handoff only points at what exists)
  const units = buildUnits(msgs, { session: sid8, k })
  let indexed = false
  let archivePath: string | undefined
  let archiveText: string | undefined
  if (dir) {
    try {
      const parts = serializeUnits(units)
      for (const [j, part] of parts.entries()) await $.fs.write(`${dir}/index/${name}-p${j + 1}.jsonl`, part)
      indexed = true
    } catch (err) {
      failures.push(`index: ${errText(err)}`)
    }
    try {
      archiveText = buildArchive(msgs)
      await $.fs.write(`${dir}/archive/${name}.txt`, archiveText)
      archivePath = `${dir}/archive/${name}.txt`
    } catch (err) {
      failures.push(`archive: ${errText(err)}`)
    }
  }

  // 3-4. digest and state of work
  const prevK = k - 1
  const asked = await writeState($, cfg, msgs, prevK, e.instructions)
  // refs past this archive's end are repaired from the previous state or dropped (0.2.3); new lines labelled
  // with the previous shrink's number go back to plain #n (0.2.4), unless Haiku read that #k:n in the digest (0.2.5)
  const previous = previousStateOf(e.messages)
  const prevQualified = previous !== undefined && prevK >= 1 ? qualifyRefs(previous, prevK) : ''
  // refs to empty lines (no text, never in the digest) are dead: repaired from the previous state or dropped (0.2.7)
  const archiveLines = new Map<number, number>()
  const emptyByArchive = new Map<number, Set<number>>()
  if (asked.text)
    for (const [j, path] of archives) {
      const text = await $.fs.read(path).catch(() => undefined)
      const count = typeof text === 'string' ? archiveLineCount(text) : 0
      if (count > 0) archiveLines.set(j, count) // unreadable or empty: unknown, so its refs are kept
      if (count > 0) emptyByArchive.set(j, archiveEmptyLines(text as string))
    }
  const empty = { current: archiveText !== undefined ? archiveEmptyLines(archiveText) : undefined, byArchive: emptyByArchive }
  const refCheck = asked.text
    ? checkRefs(asked.text, msgs.length, prevQualified, archiveLines, prevK >= 1 ? prevK : undefined, asked.read, empty)
    : undefined
  if (refCheck) asked.text = refCheck.text

  // 5-7. facts, handoff, tail
  const facts = buildFacts(msgs, {
    verbatimUserMessages: VERBATIM_USER_MESSAGES,
    factsBudgetChars: cfg.factsBudgetChars,
    archivePath,
    transcriptPath: transcriptPath || undefined,
    earlierResets: earlier,
    earlierArchives: archives,
    stateText: asked.text,
    home: await homeOf($),
  })
  const handoffText = buildHandoff({
    state: asked.text,
    facts,
    k,
    recallTool: indexed ? await ensureRecallTool($) : undefined,
    archivePath,
    queued: queuedSection(queued),
  })
  const handoff: SessionMessage = { role: 'user', text: handoffText, toolUses: [] }
  const tail = trimTail(e.messages.slice(start), cfg.tailChars)
  // A kept tool-result message goes without its handle, so the engine writes it fresh: kept whole, the engine's
  // copy keeps its old parent link, and a resume walked back past the handoff into the shrunk conversation (0.2.3)
  const messages = [handoff, ...tail.map(m => (m.toolResults?.length ? withoutHandle(m) : m))]

  // 8. the handoff file
  let handoffPath: string | undefined
  if (dir) {
    try {
      await $.fs.write(`${dir}/session-handoff_${name}.md`, `${handoffText}\n`)
      handoffPath = `${dir}/session-handoff_${name}.md`
    } catch (err) {
      failures.push(`handoff: ${errText(err)}`)
    }
  }
  debug(
    $,
    `shrink ${k} ${e.trigger}: digest ${asked.digestChars} chars, est ${asked.estTokens} of ${cfg.haikuBudgetTokens} tokens, ` +
      `${asked.sharded ? `${asked.sharded.slices} parts + merge, ` : ''}` +
      `${asked.text ? `Haiku ${asked.ms ?? '?'}ms, state ${asked.text.length} chars` : `no state (${asked.why ?? '?'})`}, ` +
      `refs ${refCheck ? `${refCheck.plain} plain / ${refCheck.qualified} old / ${refCheck.repaired} fixed / ${refCheck.dropped} dropped / ${refCheck.dead} dead` : 'n/a'}, ` +
      `handoff ${handoffText.length} chars, tail ${e.messages.length - start} msgs ${tailSize(tail)} chars` +
      `${queued.length ? `, queued ${queued.length}` : ''}${queuedError ? `, queued messages not read (${queuedError})` : ''}` +
      `${failures.length ? `, problems: ${failures.join('; ')}` : ''}`,
  )

  try {
    const u = asked.usage
    await recordShrink($, {
      k,
      at: now,
      trigger: e.trigger,
      before,
      state: asked.text ? 'haiku' : 'none',
      haikuTokens: u ? u.input_tokens + u.output_tokens : undefined,
      ms: (await $.clock.now()) - startedAt,
      handoffPath,
    })
  } catch (err) {
    debug($, `panel row not recorded: ${errText(err)}`)
  }

  const how = asked.text ? '' : cfg.mode === 'code' ? ' (code-only handoff)' : ` (code-only handoff: Haiku ${asked.why ?? 'gave nothing'})`
  if (!dir) toast($, `shrink: shrink ${k} done; nothing saved (no transcript path; set handoffDir)${how}`)
  else if (failures.length) toast($, `shrink: shrink ${k} done, but files not written (${failures.join('; ')})${how}`)
  else toast($, `shrink: shrink ${k} saved to ${handoffPath}${how}`)

  return { messages }
}

// ---------------------------------------------------------------- recall (design 4)

const RECALL_TOOL = 'mcp__shrink__recall'
const EVIDENCE_CHARS = 60000
const READER_MAX_TOKENS = 1500
const READER_ATTEMPTS = 2
/** Room in a reader request for the question's note, the gate feedback and the wrapper text. */
const READER_PROMPT_RESERVE_TOKENS = 1500
/** Hits searched when a verified draft abstains and the reader looks once more, wider (design 4.3). */
const WIDE_HITS = 24
const LEADS_SHOWN = 3
const RAW_SHOWN = 5

/** Index shards by path; a shard is written once under a new name, so its parse never goes stale. */
const shardCache = new Map<string, Unit[]>()

async function loadUnits($: EngineInterface, dir: string, sid8: string, scope: Config['recallScope']): Promise<Unit[]> {
  const entries = await $.fs.list(`${dir}/index`).catch(() => [])
  const names = entries
    .map(e => e.name)
    .filter(n => n.endsWith('.jsonl') && (scope === 'project' || n.includes(`_${sid8}-`)))
    .sort()
  const units: Unit[] = []
  for (const name of names) {
    const path = `${dir}/index/${name}`
    let parsed = shardCache.get(path)
    if (parsed === undefined) {
      const raw = await $.fs.read(path).catch(() => undefined)
      if (typeof raw !== 'string') continue
      parsed = parseUnits(raw)
      shardCache.set(path, parsed)
    }
    units.push(...parsed)
  }
  return units
}

type RecallRow = { calls: number }

async function recall($: EngineInterface, cfg: Config, question: string, leads: string[]): Promise<{ text: string; outcome: RecallOutcome['kind']; row: RecallRow }> {
  const row: RecallRow = { calls: 0 }
  const done = (o: RecallOutcome) => ({ text: formatRecall(o), outcome: o.kind, row })
  const sid8 = (await $.session.id()).slice(0, 8)
  const transcriptPath = (await $.session.info().catch(() => undefined))?.transcriptPath ?? ''
  const dir = await resolveDir($, cfg, transcriptPath)
  if (!dir) return done({ kind: 'unavailable', why: 'no handoff folder for this session (no transcript path; set handoffDir)' })
  const units = await loadUnits($, dir, sid8, cfg.recallScope)
  if (units.length === 0)
    return done({ kind: 'unavailable', why: `nothing archived yet for this ${cfg.recallScope === 'project' ? 'project' : 'session'}` })

  const hits = search(units, { question, leads }, { currentSession: sid8 })
  if (hits.length === 0) return done({ kind: 'not-found', leads: [] })
  const ceiling = cfg.haikuBudgetTokens - IDENTITY_RESERVE_TOKENS - estimateTokens(READER_SYSTEM) - estimateTokens(question) - READER_PROMPT_RESERVE_TOKENS
  const chosen = expand(units, hits, EVIDENCE_CHARS, ceiling, RANKED_HITS)
  const { text: evidenceText, evidence } = renderEvidence(chosen)
  const note = namedNote(evidence, hits)
  const top = (n: number) => hits.slice(0, n).map(h => h.unit)
  const read = async (evidenceText: string, feedback: string | undefined, note: string | undefined) => {
    const asked = await ask($, cfg, READER_SYSTEM, readerPrompt(question, evidenceText, feedback, note), { maxTokens: READER_MAX_TOKENS, effort: cfg.recallEffort })
    row.calls++
    return asked
  }

  // A verified "not found" from the top hits: one more read with the top 24 and evidence up to the ceiling,
  // when that shows more than the first read did (design 4.3). Undefined: keep the first outcome.
  const widen = async (): Promise<RecallOutcome | undefined> => {
    const wide = search(units, { question, leads }, { currentSession: sid8, top: WIDE_HITS })
    const more = expand(units, wide, Infinity, ceiling)
    if (more.length <= chosen.length) return undefined
    const r = renderEvidence(more)
    const asked = await read(r.text, undefined, namedNote(r.evidence, wide))
    if (!asked.text) return undefined
    const draft = parseDraft(asked.text)
    const problems = draft === undefined ? ['G0:not_json'] : checkDraft(draft, r.evidence, question)
    if (draft && problems.length === 0 && !draft.abstain) return { kind: 'answer', draft, evidence: r.evidence }
    return { kind: 'not-found', leads: wide.slice(0, LEADS_SHOWN).map(h => h.unit) }
  }

  let feedback: string | undefined
  for (let attempt = 0; attempt < READER_ATTEMPTS; attempt++) {
    const asked = await read(evidenceText, feedback, note)
    if (!asked.text) return done({ kind: 'raw', units: top(RAW_SHOWN), why: `the reader model ${asked.why ?? 'gave nothing'}` })
    const draft = parseDraft(asked.text)
    const problems = draft === undefined ? ['G0:not_json'] : checkDraft(draft, evidence, question)
    if (draft && problems.length === 0) {
      if (!draft.abstain) return done({ kind: 'answer', draft, evidence })
      return done((await widen()) ?? { kind: 'not-found', leads: top(LEADS_SHOWN) })
    }
    feedback = problems.join('; ')
  }
  return done({ kind: 'raw', units: top(RAW_SHOWN), why: 'the answer could not be verified against the archive' })
}

const RECALL_DESCRIPTION =
  'Ask about anything from earlier in this session that was shrunk away (and, by default, from this project\'s ' +
  'earlier sessions). Searches the full archived conversation: the user\'s words, tool outputs, errors, commands, ' +
  'file paths and decisions, and answers with exact quotes and their archive refs, or says it is not there. Use it ' +
  'before guessing or re-doing work. Give a precise question and leads: file names, error words, ids, commands.'

const RECALL_INPUT = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'What you need to know, as a precise question.' },
    leads: { type: 'array', items: { type: 'string' }, description: 'File names, error words, ids or commands to aim the search.' },
  },
  required: ['question'],
}

/** Registers the recall tool once; at a shrink too, so a handoff only names a tool that exists. */
async function ensureRecallTool($: EngineInterface): Promise<string | undefined> {
  if (recallTool !== undefined) return recallTool
  try {
    recallTool = (await $.tool.register({ name: 'recall', description: RECALL_DESCRIPTION, inputSchema: RECALL_INPUT, isDeferred: false })).tool
  } catch (err) {
    debug($, `recall tool not registered: ${errText(err)}`)
  }
  return recallTool
}

const MANUAL_DELAY_MS = 50
const MANUAL_TRIES = 5
const MANUAL_RETRY_MS = 2000

/** `/shrink now`: runs `/compact [focus]` as if typed, once the session is idle. Never rejects.
 *  Not `$.session.compact`: an SDK host (the VS Code extension, `claude -p`) rejects that ("not available in a
 *  headless session"), while `/compact` works on every surface and reaches the shrink as a manual compaction. */
async function manualShrink($: EngineInterface, focus: string | undefined): Promise<void> {
  let why = ''
  debug($, '/shrink now: timer fired')
  for (let i = 1; i <= MANUAL_TRIES; i++) {
    try {
      await $.command.run({ command: 'compact', args: focus ?? '' })
      return // the shrink's own toast reports the shrink itself
    } catch (err) {
      why = errText(err)
      debug($, `/shrink now try ${i}: ${why}`)
      await $.clock.sleep(MANUAL_RETRY_MS).catch(() => undefined)
    }
  }
  toast($, `shrink: /shrink now could not start (${why}); run /compact instead`)
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await ensureRecallTool($)
    await $.command
      .register({ name: 'shrink', description: 'Shrink panel; "/shrink now [focus]" shrinks the conversation now', argumentHint: '[now [focus] | help]' })
      .catch(err => debug($, `/shrink not registered: ${errText(err)}`))
    const started = await next(e)
    try {
      const usage = await $.session.usage({ breakdown: 'summary' })
      const threshold = usage.context.breakdown?.autoCompactThreshold
      const transcriptPath = (await $.session.info().catch(() => undefined))?.transcriptPath ?? ''
      debug(
        $,
        `session start: shrink ${MOD_VERSION}, mode ${cfg.mode}, model ${cfg.shrinkModel}, threshold ${threshold === undefined ? 'none' : `${Math.round(threshold / 1000)}k`}, ` +
          `context ${Math.round((usage.context.tokens ?? 0) / 1000)}k of ${Math.round(usage.context.window / 1000)}k, recall ${cfg.recallScope}, surface ${e.surface}, transcript ${transcriptPath || 'none'}`,
      )
      await recordFill($, { tokens: usage.context.tokens, threshold }).catch(() => undefined)
      if (threshold === undefined)
        toast($, `shrink: auto-compact is off (no threshold), so only /compact runs the shrink; set "autoCompactEnabled": true and "autoCompactWindow": ${RECOMMENDED_WINDOW} in ~/.claude/settings.json, then start a new session`)
      else if (threshold > cfg.thresholdWarnAbove)
        toast($, `shrink: auto-compact threshold is ${threshold}; set "autoCompactWindow": ${RECOMMENDED_WINDOW} in ~/.claude/settings.json, then start a new session`)
    } catch {
      // never block a session start over a warning
    }
    return started
  })

  registerUi(on)

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) {
      await recordFill($, { tokens: e.context.tokens }).catch(() => undefined)
    }
    return result
  })

  on('command.run', { command: 'shrink' }, async ($, e) => {
    const cmd = parseShrinkArgs(e.args)
    if (cmd.kind === 'help') return { text: SHRINK_HELP }
    if (cmd.kind === 'unknown') return { text: `Unknown /shrink option "${cmd.word}".\n${SHRINK_HELP}` }
    if (cmd.kind === 'now') {
      // A compaction cannot run under the turn this command holds: start it once the command returns.
      $.clock.after(MANUAL_DELAY_MS, () => void manualShrink($, cmd.focus))
      return { text: `Shrinking now${cmd.focus ? ` (focus: ${cmd.focus})` : ''}; a toast says when it is done.` }
    }
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return { text: 'Shrink panel opened. /shrink now shrinks the conversation; /shrink help lists the options.' }
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e) // subagents keep the built-in
    }
    if (e.trigger === 'precompute') return { skip: 'shrink: the shrink is made at the reset itself, by Haiku' }
    const startedAt = await $.clock.now().catch(() => 0)
    try {
      return await shrink($, cfg, e, startedAt)
    } catch (err) {
      debug($, `shrink failed: ${errText(err)}`)
      toast($, `shrink: failed (${errText(err)}); the built-in compaction runs`)
      return next(e)
    }
  }).catch(($, e, next) => next(e)) // the hook failed or overran: the engine compacts

  on('tool.call', { tool: RECALL_TOOL }, async ($, e) => {
    const startedAt = await $.clock.now().catch(() => 0)
    const args = e as unknown as { question?: unknown; leads?: unknown }
    const question = typeof args.question === 'string' ? args.question.trim() : ''
    const leads = Array.isArray(args.leads) ? args.leads.filter((l): l is string => typeof l === 'string') : []
    if (question === '') return { result: 'Recall needs a question.' }
    try {
      const r = await recall($, cfg, question, leads)
      await recordRecall($, { at: startedAt, question, outcome: r.outcome, tries: r.row.calls }).catch(() => undefined)
      return { result: r.text }
    } catch (err) {
      debug($, `recall failed: ${errText(err)}`)
      await recordRecall($, { at: startedAt, question, outcome: 'failed', tries: 0 }).catch(() => undefined)
      return { result: `Recall failed: ${errText(err)}. Grep the archive under the handoffs folder instead.` }
    }
  }).catch(() => ({ result: 'Recall failed. Grep the archive under the handoffs folder instead.' }))
}
