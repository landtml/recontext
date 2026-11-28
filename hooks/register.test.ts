// Hook tests: the hooks a test registers on `on` sit beneath the plugin and stand in for the
// engine (its summarizer, the session, files, clock, toasts and Haiku).
import type { ModelCompleteResult, On, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { estimateRequest } from './budget'
import { MAP_SYSTEM, STATE_SYSTEM } from './handoff'
import { HANDOFF_HEADER } from './prompt'
import { emptyIndex, mergeIndex, parseIndex, serializeIndex } from './index'
import { SLICE_TITLE } from './facts'
import { READER_SYSTEM } from './reader'
import { buildUnits, parseUnits, serializeUnits } from './units'

const SID = 'abcd1234-5678-90ab-cdef-000000000000'
const PROJECT = '/home/u/.claude/projects/-home-u-proj'
const TRANSCRIPT = `${PROJECT}/${SID}.jsonl`
const DIR = `${PROJECT}/handoffs`
const NOON = Date.UTC(2026, 10, 24, 12, 0, 0)
const NAME = '2026-11-24_abcd1234-1'
const TOOL = 'mcp__shrink__recall'

const INPUT: SessionMessage[] = [
  { role: 'user', text: 'build the parser for tabs', toolUses: [], handle: 'h1' },
  {
    role: 'assistant',
    text: 'On it.',
    toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'python3 parse.py' }, text: 'Exit code 1\nValueError: tab at line 3', isError: true }],
    handle: 'h2',
  },
  { role: 'user', text: 'and add tests', toolUses: [], handle: 'h3' },
  { role: 'assistant', text: 'Done.', toolUses: [], handle: 'h4' },
]
const ENGINE: SessionCompactResult = { messages: [{ role: 'user', text: 'engine summary', toolUses: [], handle: 'h-sum' }] }
const STATE = '## Goal\nparse tabs\n## Current task and next step\nadd tests\n## Decisions and why\nnone\n## Tried and failed\nnone\n## Open questions\nnone\n## Files to re-read first\nnone\n## Memory candidates\nnone'
const usage = { input_tokens: 9000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const answered = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage })

type World = {
  beneath: SessionCompactInput[]
  asks: { model: string; system?: unknown; prompt: unknown; effort?: string; maxTokens?: number }[]
  writes: Map<string, string>
  toasts: string[]
  registered: unknown[]
}

function engine(
  on: On,
  opts: { files?: Record<string, string>; haiku?: (system: string, prompt: string, n: number) => ModelCompleteResult; failWrites?: boolean; failId?: boolean } = {},
): World {
  const w: World = { beneath: [], asks: [], writes: new Map(Object.entries(opts.files ?? {})), toasts: [], registered: [] }
  mock.clock(on, { now: NOON })
  on('session.compact', (_, e) => {
    w.beneath.push(e)
    return ENGINE
  })
  on('model.complete', (_, e) => {
    w.asks.push(e)
    const system = typeof e.system === 'string' ? e.system : ''
    const prompt = typeof e.prompt === 'string' ? e.prompt : ''
    return { value: (opts.haiku ?? (s => answered(s === STATE_SYSTEM ? STATE : '{"abstain":true}')))(system, prompt, w.asks.length) }
  })
  on('tool.register', (_, e) => {
    w.registered.push(e)
    return { value: { tool: TOOL } }
  })
  on('session.id', () => (opts.failId ? { deny: 'no id here' } : { value: SID }))
  on('session.info', () => ({ value: { transcriptPath: TRANSCRIPT } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.write', (_, e) => {
    if (opts.failWrites) return { deny: 'EACCES: permission denied' }
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: w.writes.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = w.writes.get(e.path)
    if (text === undefined) return { deny: `ENOENT: ${e.path}` }
    const from = e.offset ?? 0
    return { value: e.offset !== undefined || e.length !== undefined ? text.slice(from, e.length !== undefined ? from + e.length : undefined) : text }
  })
  on('fs.stat', (_, e) => {
    const text = w.writes.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.list', (_, e) => {
    const names = [...w.writes.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!)
    if (names.length === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: [...new Set(names)].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  return w
}

const compact = (
  $: { session: { compact: (e: SessionCompactInput) => Promise<SessionCompactResult> } },
  e: Partial<SessionCompactInput> = {},
) => $.session.compact({ trigger: 'auto', messages: INPUT, ...e })

const messagesOf = (r: SessionCompactResult): readonly SessionMessage[] => {
  if (r.skip !== undefined) throw new Error(`skipped: ${r.skip}`)
  return r.messages
}

// ---------------------------------------------------------------- the shrink

test('auto: Haiku writes the state from the digest; the engine summarizer never runs', async ($, on) => {
  const w = engine(on)
  const out = messagesOf(await compact($))
  expect(w.beneath).toHaveLength(0)
  expect(w.asks).toHaveLength(1)
  expect(w.asks[0]!.model).toBe('haiku')
  expect(w.asks[0]!.system).toBe(STATE_SYSTEM)
  expect(String(w.asks[0]!.prompt)).toContain('#1 user: build the parser for tabs')
  expect(String(w.asks[0]!.prompt)).toContain('→ error: ValueError: tab at line 3')
  expect(String(w.asks[0]!.prompt)).not.toContain('Exit code 1')
  const handoff = out[0]!
  expect(handoff.role).toBe('user')
  expect(handoff.handle).toBeUndefined()
  expect(handoff.text).toStartWith(HANDOFF_HEADER)
  expect(handoff.text).toContain(`## State of work\n${STATE}`)
  expect(handoff.text).toContain('# Handoff facts (exact, extracted by code)')
  expect(handoff.text).toContain(`\`${TOOL}\``)
})

test('the kept tail is the last messages, with their engine handles', async ($, on) => {
  engine(on)
  const out = messagesOf(await compact($))
  expect(out.slice(1).map(m => m.handle)).toEqual(['h1', 'h2', 'h3', 'h4'])
})

test('a kept tool-result message loses its handle (resume chain); every other kept message keeps its own', async ($, on) => {
  engine(on)
  const call: SessionMessage = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/p/a' } }], handle: 'hc' }
  const result: SessionMessage = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: 'body', isError: false }], handle: 'hr' }
  const out = messagesOf(await compact($, { messages: [...INPUT, call, result, { role: 'assistant', text: 'ok', toolUses: [], handle: 'h7' }] }))
  expect(out.slice(1).map(m => m.handle)).toEqual(['h1', 'h2', 'h3', 'h4', 'hc', undefined, 'h7'])
  expect(out.find(m => m.toolResults?.length)!.toolResults![0]!.text).toBe('body')
})

test('manual /compact text reaches Haiku as the focus', async ($, on) => {
  const w = engine(on)
  await compact($, { trigger: 'manual', instructions: 'keep the parser plan' })
  expect(String(w.asks[0]!.prompt)).toStartWith('The user asked this shrink to focus on: keep the parser plan')
})

test('Haiku unavailable: a code-only handoff, and one toast says so', async ($, on) => {
  const w = engine(on, { haiku: () => ({ isAnswered: false, reason: 'aborted', usage }) as ModelCompleteResult })
  const out = messagesOf(await compact($))
  expect(out[0]!.text).toContain('code-only handoff')
  expect(w.beneath).toHaveLength(0)
  expect(w.toasts.some(t => t.includes('code-only'))).toBe(true)
})

test('mode code makes no model call', { options: { mode: 'code' } }, async ($, on) => {
  const w = engine(on)
  const out = messagesOf(await compact($))
  expect(w.asks).toHaveLength(0)
  expect(out[0]!.text).toContain('code-only handoff')
})

test('precompute is skipped, so the session model never summarizes ahead', async ($, on) => {
  const w = engine(on)
  const out = await compact($, { trigger: 'precompute' })
  expect(out.skip).toBeDefined()
  expect(w.beneath).toHaveLength(0)
  expect(w.asks).toHaveLength(0)
})

// a subagent's compaction is shrunk too, under its own label (0.2.11; up to 0.2.10 the engine's summarizer ran)
const AGENT = 'a0ef7f85566e49b8c'
const ALABEL = 'suba0ef7f85'
const ANAME = `2026-11-24_${ALABEL}-1`
const AGENT_TRANSCRIPT = `${PROJECT}/${SID}/subagents/agent-${AGENT}.jsonl`

test('a subagent compaction runs the Haiku shrink, under its own label (0.2.11)', async ($, on) => {
  const w = engine(on, { files: { [AGENT_TRANSCRIPT]: '{}\n' } })
  const out = messagesOf(await compact($, { agentId: AGENT }))
  expect(w.beneath).toHaveLength(0)
  expect(w.asks).toHaveLength(1)
  expect(w.asks[0]!.system).toBe(STATE_SYSTEM)
  expect(out[0]!.text).toStartWith(HANDOFF_HEADER)
  expect(out.slice(1).map(m => m.handle)).toEqual(['h1', 'h2', 'h3', 'h4'])
  expect(parseUnits(w.writes.get(`${DIR}/index/${ANAME}-p1.jsonl`)!).map(u => u.ref)).toContain(`${ALABEL}-1#2.1`)
  expect(w.writes.get(`${DIR}/archive/${ANAME}.txt`)).toStartWith('#1 user | build the parser for tabs\n')
  const handoff = w.writes.get(`${DIR}/session-handoff_${ANAME}.md`)!
  expect(handoff).toContain(`- Original transcript: ${AGENT_TRANSCRIPT}`)
  expect(handoff).not.toContain(`- Original transcript: ${TRANSCRIPT}`)
})

test('subagent files never touch the session\'s numbering: each label counts its own k (0.2.11)', async ($, on) => {
  const w = engine(on, { files: { [`${DIR}/session-handoff_2026-11-24_abcd1234-1.md`]: 'x', [`${DIR}/session-handoff_2026-11-24_${ALABEL}-1.md`]: 'x' } })
  await compact($, { agentId: AGENT })
  expect(w.writes.has(`${DIR}/session-handoff_2026-11-24_${ALABEL}-2.md`)).toBe(true)
  await compact($)
  expect(w.writes.has(`${DIR}/session-handoff_2026-11-24_abcd1234-2.md`)).toBe(true)
  expect(w.writes.has(`${DIR}/session-handoff_2026-11-24_abcd1234-3.md`)).toBe(false)
})

test('a subagent shrink that fails returns the engine\'s own result, next called once (0.2.11)', async ($, on) => {
  const w = engine(on)
  const orphan: SessionMessage[] = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'gone', text: 'r', isError: false }], handle: 'o1' }]
  const out = await compact($, { agentId: AGENT, messages: orphan })
  expect(out).toEqual(ENGINE)
  expect(w.beneath).toHaveLength(1)
  expect(w.toasts).toEqual([])
})

test('a subagent shrink shows the person no toast (0.2.11; the bar is checked in ui.test)', async ($, on) => {
  const w = engine(on)
  await compact($, { agentId: AGENT })
  expect(w.toasts).toEqual([])
  expect(w.writes.has(`${DIR}/session-handoff_${ANAME}.md`)).toBe(true)
})

test('a subagent precompute is skipped, as the session\'s is (0.2.11)', async ($, on) => {
  const w = engine(on)
  const out = await compact($, { agentId: AGENT, trigger: 'precompute' })
  expect(out.skip).toBeDefined()
  expect(w.beneath).toHaveLength(0)
  expect(w.asks).toHaveLength(0)
})

test('no valid tail: the engine\'s own compaction runs instead', async ($, on) => {
  const w = engine(on)
  const orphan: SessionMessage[] = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'gone', text: 'r', isError: false }], handle: 'o1' }]
  const out = await compact($, { messages: orphan })
  expect(out).toEqual(ENGINE)
  expect(w.beneath).toHaveLength(1)
})

test('writes index shards, the archive and the handoff file, and no log files', async ($, on) => {
  const w = engine(on)
  await compact($)
  const units = parseUnits(w.writes.get(`${DIR}/index/${NAME}-p1.jsonl`)!)
  expect(units.map(u => u.ref)).toContain('abcd1234-1#2.1')
  expect(w.writes.get(`${DIR}/archive/${NAME}.txt`)).toStartWith('#1 user | build the parser for tabs\n')
  expect(w.writes.get(`${DIR}/session-handoff_${NAME}.md`)).toContain(HANDOFF_HEADER)
  expect([...w.writes.keys()].filter(p => /\.(log|jsonl)$/.test(p) && !p.includes('/index/') && !p.includes('/items/'))).toEqual([])
  expect(w.toasts).toEqual([`shrink: shrink 1 saved to ${DIR}/session-handoff_${NAME}.md`])
})

test('writes the session item index at a shrink (0.3.0)', async ($, on) => {
  const w = engine(on)
  await compact($)
  const text = w.writes.get(`${DIR}/items/abcd1234.jsonl`)
  expect(text).toBeDefined()
  const idx = parseIndex(text)
  expect(idx.head.k).toBe(1)
  expect(idx.head.pos).toBeGreaterThan(0)
})

test('the handoff carries the ranked index slice in place of the item lists (0.3.0)', async ($, on) => {
  const w = engine(on)
  await compact($)
  const handoff = w.writes.get(`${DIR}/session-handoff_${NAME}.md`)!
  expect(handoff).toContain(SLICE_TITLE)
  expect(handoff).not.toContain('## Files touched')
})

test('a subagent shrink leaves the session item index alone (0.3.0)', async ($, on) => {
  const w = engine(on, { files: { [AGENT_TRANSCRIPT]: '{}\n' } })
  await compact($, { agentId: AGENT })
  expect([...w.writes.keys()].some(k => k.includes('/items/'))).toBe(false)
})

test('a second shrink in the session is k 2 and names the first', async ($, on) => {
  const w = engine(on, { files: { [`${DIR}/session-handoff_2026-11-24_abcd1234-1.md`]: 'x' } })
  const out = messagesOf(await compact($))
  expect(w.writes.has(`${DIR}/session-handoff_2026-11-24_abcd1234-2.md`)).toBe(true)
  expect(out[0]!.text).toContain('session-handoff_2026-11-24_abcd1234-1.md')
})

test('a second shrink: old refs reach Haiku as #1:n; stale refs are fixed or dropped; archives listed', async ($, on) => {
  const prior: SessionMessage = {
    role: 'user',
    text: `${HANDOFF_HEADER}\n## State of work\n## Goal\nparse tabs (#40)\n\n# Handoff facts (exact, extracted by code)\n- x`,
    toolUses: [],
  }
  const w = engine(on, {
    files: { [`${DIR}/session-handoff_2026-11-24_abcd1234-1.md`]: 'x', [`${DIR}/archive/2026-11-24_abcd1234-1.txt`]: Array.from({ length: 50 }, (_, i) => `#${i + 1} user | m`).join('\n') },
    haiku: s => answered(s === STATE_SYSTEM ? '## Goal\nparse tabs (#40, #2, #1:60)\n## Decisions and why\nused tabs (#77)\n## Current task and next step\nnone\n## Tried and failed\nnone\n## Open questions\nnone\n## Files to re-read first\nnone\n## Memory candidates\nnone' : '{"abstain":true}'),
  })
  const out = messagesOf(await compact($, { messages: [prior, ...INPUT] }))
  expect(String(w.asks[0]!.prompt)).toContain('parse tabs (#1:40)')
  expect(out[0]!.text).toContain('parse tabs (#1:40, #2)\n## Decisions and why\nused tabs\n')
  expect(out[0]!.text).toContain(`Earlier archives (\`#k:n\` is line n of shrink k's archive: 1), in ${DIR}/archive/: 2026-11-24_abcd1234-1.txt`)
})

test("a fork's first shrink: the handoff it inherited keeps its session's refs, and Where to look names that archive (0.2.11)", async ($, on) => {
  const other = '/home/u/.claude/projects/-home-u-proj/handoffs/archive/2026-11-23_4a9e7c13-3.txt'
  const prior: SessionMessage = {
    role: 'user',
    text: `${HANDOFF_HEADER}\n## State of work\n## Goal\nparse tabs (#40, #2:17)\n\n# Handoff facts (exact, extracted by code)\n## Where to look\n- Archive: ${other} (one line per message: \`#n role tool | text\`)`,
    toolUses: [],
  }
  const w = engine(on, {
    haiku: s => answered(s === STATE_SYSTEM ? '## Goal\nparse tabs (4a9e7c13-3#40, 4a9e7c13-2#17, #2)\n## Decisions and why\nnone\n## Current task and next step\nnone\n## Tried and failed\nnone\n## Open questions\nnone\n## Files to re-read first\nnone\n## Memory candidates\nnone' : '{"abstain":true}'),
  })
  const out = messagesOf(await compact($, { messages: [prior, ...INPUT] }))
  // this session (abcd1234) has no earlier shrink, so k = 1: 0.2.10 showed these refs plain, later read as #1:40
  expect(String(w.asks[0]!.prompt)).toContain('parse tabs (4a9e7c13-3#40, 4a9e7c13-2#17)')
  expect(out[0]!.text).toContain('parse tabs (4a9e7c13-3#40, 4a9e7c13-2#17, #2)\n')
  expect(out[0]!.text).toContain(`- Archive of the session this one continues (its refs read \`4a9e7c13-k#n\`): ${other}`)
})

test("a fork's first shrink seeds its item index from the parent's, with the parent's refs qualified (0.3.0)", async ($, on) => {
  const other = '/home/u/.claude/projects/-home-u-proj/handoffs/archive/2026-11-23_4a9e7c13-3.txt'
  const parentIndex = mergeIndex(emptyIndex(), [{ role: 'assistant', text: 'edit tools/x_file.py', toolUses: [] }], { k: 3 })
  const prior: SessionMessage = {
    role: 'user',
    text: `${HANDOFF_HEADER}\n## State of work\n## Goal\nparse tabs (#40)\n\n# Handoff facts (exact, extracted by code)\n## Where to look\n- Archive: ${other} (one line)`,
    toolUses: [],
  }
  const w = engine(on, { files: { '/home/u/.claude/projects/-home-u-proj/handoffs/items/4a9e7c13.jsonl': serializeIndex(parentIndex) } })
  await compact($, { messages: [prior, ...INPUT] })
  const idx = parseIndex(w.writes.get(`${DIR}/items/abcd1234.jsonl`))
  expect(idx.head.k).toBe(1)
  expect(idx.entries.get('tools/x_file.py')!.refs).toEqual(['4a9e7c13-3#1'])
  expect(idx.entries.get('tools/x_file.py')!.lastSeg).toBe(0)
})

test('a second shrink: refs to empty archive lines are dead and dropped (0.2.7)', async ($, on) => {
  const prior: SessionMessage = {
    role: 'user',
    text: `${HANDOFF_HEADER}\n## State of work\n## Goal\nparse tabs (#40)\n\n# Handoff facts (exact, extracted by code)\n- x`,
    toolUses: [],
  }
  const thinkingOnly: SessionMessage = { role: 'assistant', text: '', toolUses: [] }
  const archive1 = Array.from({ length: 50 }, (_, i) => (i + 1 === 30 ? '#30 assistant | ' : `#${i + 1} user | m`)).join('\n')
  const w = engine(on, {
    files: { [`${DIR}/session-handoff_2026-11-24_abcd1234-1.md`]: 'x', [`${DIR}/archive/2026-11-24_abcd1234-1.txt`]: archive1 },
    haiku: s => answered(s === STATE_SYSTEM ? '## Goal\nparse tabs (#1:30, #1:31, #2, #3)\n## Decisions and why\nnone\n## Current task and next step\nnone\n## Tried and failed\nnone\n## Open questions\nnone\n## Files to re-read first\nnone\n## Memory candidates\nnone' : '{"abstain":true}'),
  })
  const out = messagesOf(await compact($, { messages: [prior, thinkingOnly, ...INPUT] }))
  expect(w.writes.get(`${DIR}/archive/2026-11-24_abcd1234-2.txt`)).toContain('#2 assistant | \n')
  expect(out[0]!.text).toContain('parse tabs (#1:31, #3)\n')
})

test('failed writes: the handoff still stands, recall is not offered, one toast names the error', async ($, on) => {
  const w = engine(on, { failWrites: true })
  const out = messagesOf(await compact($))
  expect(out[0]!.text).toStartWith(HANDOFF_HEADER)
  expect(out[0]!.text).not.toContain(TOOL)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('EACCES')
})

// ---------------------------------------------------------------- session.start

const start = async ($: { session: { start: (e: { cwd: string; surface: null; isInteractive: boolean }) => Promise<unknown> } }, on: On, threshold?: number) => {
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000, breakdown: { autoCompactThreshold: threshold } as never } },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
}

test('session.start registers the recall tool, shown up front, with a question and leads', async ($, on) => {
  const w = engine(on)
  await start($, on, 200_000)
  expect(w.registered).toHaveLength(1)
  expect(w.registered[0]).toMatchObject({ name: 'recall', isDeferred: false })
  const schema = (w.registered[0] as { inputSchema: { required: string[]; properties: Record<string, unknown> } }).inputSchema
  expect(schema.required).toEqual(['question'])
  expect(Object.keys(schema.properties)).toEqual(['question', 'leads'])
  expect(w.toasts).toEqual([])
})

test('session.start warns once when auto-compact is off', async ($, on) => {
  const w = engine(on)
  await start($, on, undefined)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('autoCompactEnabled')
})


// ---------------------------------------------------------------- the recall tool

const PAST: SessionMessage[] = [
  { role: 'user', text: 'no invoice will be sent yet, dont push anything', toolUses: [] },
  {
    role: 'assistant',
    text: 'Counting the invoices.',
    toolUses: [{ tool_use_id: 'c1', tool: 'Bash', input: { command: 'python3 count.py' }, text: '1,872 invoices in batches 1-2' }],
  },
]
const OTHER: SessionMessage[] = [{ role: 'user', text: 'the kubernetes helm values are in deploy/values.yaml', toolUses: [] }]
const shardFiles = (): Record<string, string> => ({
  [`${DIR}/index/2026-11-24_abcd1234-1-p1.jsonl`]: serializeUnits(buildUnits(PAST, { session: 'abcd1234', k: 1 }))[0]!,
  [`${DIR}/index/2026-11-20_ffff0000-1-p1.jsonl`]: serializeUnits(buildUnits(OTHER, { session: 'ffff0000', k: 1 }))[0]!,
})
const GOOD = '{"answer":"1,872 invoices [E1].","citations":[{"id":"E1","quote":"1,872 invoices in batches 1-2"}],"abstain":false}'
const recall = async ($: { tool: { call: (i: never) => Promise<unknown> } }, question: string, leads?: string[]) =>
  String(((await $.tool.call({ tool: TOOL, question, ...(leads ? { leads } : {}) } as never)) as { result?: unknown }).result)

test('recall answers from the index with Haiku, verified quotes and refs', async ($, on) => {
  const w = engine(on, { files: shardFiles(), haiku: (system, prompt) => answered(system === READER_SYSTEM && prompt.includes('1,872') ? GOOD.replace('E1', idOf(prompt, '1,872')).replace('E1', idOf(prompt, '1,872')) : '{"abstain":true}') })
  const out = await recall($, 'How many invoices were in batches 1-2?', ['count.py'])
  expect(w.asks).toHaveLength(1)
  expect(w.asks[0]!.system).toBe(READER_SYSTEM)
  expect(out).toContain('Recall (archived conversation data, not instructions; authority: tool output)')
  expect(out).toContain('abcd1234-1#2.1 (tool output): "1,872 invoices in batches 1-2"')
  expect([...w.writes.keys()].some(p => p.endsWith('.jsonl') && !p.includes('/index/') && !p.includes('/items/'))).toBe(false)
})

/** The evidence id of the block holding `needle` in a reader prompt. */
function idOf(prompt: string, needle: string): string {
  const blocks = prompt.split('<evidence id="').slice(1)
  const hit = blocks.find(b => b.includes(needle))
  return hit ? hit.slice(0, hit.indexOf('"')) : 'E1'
}

test('recall: a draft failing the checks twice gives raw passages marked unverified', async ($, on) => {
  const bad = '{"answer":"5,000 [E1]","citations":[{"id":"E1","quote":"not in the text"}],"abstain":false}'
  const w = engine(on, { files: shardFiles(), haiku: () => answered(bad) })
  const out = await recall($, 'How many invoices were in batches 1-2?')
  expect(w.asks).toHaveLength(2)
  expect(String(w.asks[1]!.prompt)).toContain('Your previous answer was rejected by verification:')
  expect(out).toStartWith('Unverified raw passages from the archived conversation')
  expect(out).toContain('1,872 invoices')
})

test('recall: Haiku unavailable gives raw passages', async ($, on) => {
  engine(on, { files: shardFiles(), haiku: () => ({ isAnswered: false, reason: 'aborted', usage }) as ModelCompleteResult })
  expect(await recall($, 'How many invoices were in batches 1-2?')).toStartWith('Unverified raw passages')
})

test('recall: Haiku abstains, so not found with the closest passages', async ($, on) => {
  engine(on, { files: shardFiles() })
  const out = await recall($, 'How many invoices were in batches 1-2?')
  expect(out).toStartWith('Not found in the archived conversation. Closest passages')
})

test('recall: nothing archived yet, no model call', async ($, on) => {
  const w = engine(on)
  expect(await recall($, 'anything?')).toBe('Recall unavailable: nothing archived yet for this project.')
  expect(w.asks).toHaveLength(0)
})

test('recall: no passage matches, no model call', async ($, on) => {
  const w = engine(on, { files: shardFiles() })
  expect(await recall($, 'Which Figma palette was picked for iOS?')).toBe('Not found in the archived conversation (no passage matched).')
  expect(w.asks).toHaveLength(0)
})

test('recall: project scope finds other sessions; session scope does not', async ($, on) => {
  engine(on, { files: shardFiles(), haiku: () => answered('{"abstain":true}') })
  expect(await recall($, 'where are the kubernetes helm values?')).toContain('ffff0000-1#1')
})

test('recall scope session: a subagent finds its own shrinks and its session\'s (0.2.11)', { options: { recallScope: 'session' } }, async ($, on) => {
  const files = { ...shardFiles(), [`${DIR}/index/2026-11-24_${ALABEL}-1-p1.jsonl`]: serializeUnits(buildUnits(OTHER, { session: ALABEL, k: 1 }))[0]! }
  engine(on, { files, haiku: () => answered('{"abstain":true}') })
  const ask = (agentId?: string) => $.tool.call({ tool: TOOL, question: 'where are the kubernetes helm values?', ...(agentId ? { agentId } : {}) } as never) as Promise<{ result?: unknown }>
  expect(String((await ask(AGENT)).result)).toContain(`${ALABEL}-1#1`)
  expect(String((await ask()).result)).toBe('Not found in the archived conversation (no passage matched).')
})

test('recall scope session ignores other sessions', { options: { recallScope: 'session' } }, async ($, on) => {
  const w = engine(on, { files: shardFiles() })
  expect(await recall($, 'where are the kubernetes helm values?')).toBe('Not found in the archived conversation (no passage matched).')
  expect(w.asks).toHaveLength(0)
})

test('recall: a failure becomes a short text result, never a rejection', async ($, on) => {
  engine(on, { files: shardFiles(), failId: true })
  expect(await recall($, 'How many invoices?')).toStartWith('Recall failed:')
})

test('a huge pending tool result in the kept tail is cut to the tail budget, still paired with its call', async ($, on) => {
  engine(on)
  const msgs: SessionMessage[] = [
    ...INPUT,
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'big', tool: 'Read', input: { file_path: '/p/big.txt' } }], handle: 'h5' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'big', text: 'L'.repeat(60_000), isError: false }], handle: 'h6' },
  ]
  const out = messagesOf(await compact($, { messages: msgs }))
  const last = out[out.length - 1]!
  expect(out[out.length - 2]!.handle).toBe('h5')
  expect(last.handle).toBeUndefined()
  expect(last.toolResults![0]!.tool_use_id).toBe('big')
  expect(last.toolResults![0]!.text.length).toBeLessThanOrEqual(24_000)
})


// ---------------------------------------------------------------- 0.2.6: budget, map and merge, effort (design 3.2–3.4)

const abstain = '{"abstain":true}'
const notAnswered = { isAnswered: false, reason: 'aborted', usage } as ModelCompleteResult

/** A long session: `turns` turns of a ~1,500-char user message and a short reply. */
const LONG = (turns: number): SessionMessage[] =>
  Array.from({ length: turns }, (_, t): SessionMessage[] => [
    { role: 'user', text: `turn ${t} asks: ${'plan the parser carefully '.repeat(56)}`, toolUses: [] },
    { role: 'assistant', text: `turn ${t} reply`, toolUses: [{ tool_use_id: `b${t}`, tool: 'Bash', input: { command: `make step${t}` }, text: 'ok' }] },
  ]).flat()

test('effort is sent on every call: the state and the reader at medium', async ($, on) => {
  // No seeded shards: this compact writes shrink 1's index, which the recall then reads.
  const w = engine(on)
  await compact($)
  expect(await recall($, 'What error did parse.py give on the tab?')).toContain('Not found in the archived conversation')
  expect(w.asks.map(a => [a.system === STATE_SYSTEM ? 'state' : 'reader', a.effort])).toEqual([['state', 'medium'], ['reader', 'medium']])
})

test('effort options are honoured', { options: { stateEffort: 'high', recallEffort: 'low' } }, async ($, on) => {
  // No seeded shards: this compact writes shrink 1's index, which the recall then reads.
  const w = engine(on)
  await compact($)
  expect(await recall($, 'What error did parse.py give on the tab?')).toContain('Not found in the archived conversation')
  expect(w.asks.map(a => a.effort)).toEqual(['high', 'low'])
})

test('over budget: map workers take notes on older parts, then one merge reads them with the newest lines raw', { options: { haikuBudgetTokens: 14000 } }, async ($, on) => {
  const w = engine(on, { haiku: (system, _p, n) => answered(system === MAP_SYSTEM ? `## Facts\nnote from call ${n}` : system === STATE_SYSTEM ? STATE : abstain) })
  const msgs = LONG(30)
  const out = messagesOf(await compact($, { messages: msgs }))
  const maps = w.asks.filter(a => a.system === MAP_SYSTEM)
  expect(maps.length).toBeGreaterThan(1)
  expect(maps.every(a => a.effort === 'medium')).toBe(true)
  const merge = w.asks.at(-1)!
  expect(merge.system).toBe(STATE_SYSTEM)
  expect(merge.effort).toBe('medium')
  const mp = String(merge.prompt)
  expect(mp).toContain('## Notes from earlier parts\n### Part 1 of')
  expect(mp).toContain('note from call 1')
  expect(mp).toContain('#59 user: turn 29 asks:')
  expect(mp).not.toContain('#1 user: turn 0 asks:')
  expect(String(maps[0]!.prompt)).toContain('#1 user: turn 0 asks:')
  for (const a of w.asks) expect(estimateRequest(String(a.system), String(a.prompt))).toBeLessThanOrEqual(14000)
  expect(out[0]!.text).toContain(`## State of work\n${STATE}`)
  expect(w.asks.map(a => (a.system === MAP_SYSTEM ? 'map' : 'state'))).toEqual([...maps.map(() => 'map'), 'state'])
})

test('a map worker that fails leaves a code note with its user lines; the merge still runs', { options: { haikuBudgetTokens: 14000 } }, async ($, on) => {
  const w = engine(on, { haiku: (system, _p, n) => (system === MAP_SYSTEM ? (n === 1 ? notAnswered : answered('## Facts\nok')) : answered(system === STATE_SYSTEM ? STATE : abstain)) })
  messagesOf(await compact($, { messages: LONG(30) }))
  const mp = String(w.asks.at(-1)!.prompt)
  expect(mp).toContain('(no notes: the note-taker failed on this part (aborted); the user\'s lines from it follow)\n#1 user: turn 0 asks:')
  expect(w.asks.at(-1)!.system).toBe(STATE_SYSTEM)
})

test('a state missing headings gets one retry at medium; the fuller reply stands', async ($, on) => {
  const cut = '## Goal\nparse tabs\n## Current task and next step\nadd'
  const w = engine(on, { haiku: (_s, _p, n) => answered(n === 1 ? cut : STATE) })
  const out = messagesOf(await compact($))
  expect(w.asks.map(a => a.effort)).toEqual(['medium', 'medium'])
  expect(out[0]!.text).toContain(`## State of work\n${STATE}`)
})

test('both replies cut off: the one missing fewer headings stands if it has the goal and current task', async ($, on) => {
  const better = '## Goal\nparse tabs\n## Current task and next step\nadd tests\n## Decisions and why\nnone'
  engine(on, { haiku: (_s, _p, n) => answered(n === 1 ? better : '## Goal\nparse tabs\n## Current task and next step\nadd') })
  expect(messagesOf(await compact($))[0]!.text).toContain(`## State of work\n${better}`)
})

test('no goal or current task after the retry: a code-only handoff', async ($, on) => {
  const w = engine(on, { haiku: () => answered('## Decisions and why\nnone') })
  const out = messagesOf(await compact($))
  expect(out[0]!.text).toContain('code-only handoff')
  expect(w.asks).toHaveLength(2)
  expect(w.toasts.at(-1)).toContain('state cut off (missing Goal, Current task and next step')
})

test('a state call at high that times out is retried once at medium; other failures are not retried', { options: { stateEffort: 'high' } }, async ($, on) => {
  const w = engine(on, { haiku: (_s, _p, n) => (n === 1 ? notAnswered : answered(STATE)) })
  const out = messagesOf(await compact($))
  expect(w.asks.map(a => a.effort)).toEqual(['high', 'medium'])
  expect(out[0]!.text).toContain(`## State of work\n${STATE}`)
})

test('at medium a timed-out state call is not retried', { options: { stateEffort: 'medium' } }, async ($, on) => {
  const w = engine(on, { haiku: () => notAnswered })
  expect(messagesOf(await compact($))[0]!.text).toContain('code-only handoff')
  expect(w.asks).toHaveLength(1)
})

/** An index of 40 long notes that all match one question, more than one read's 60k chars of evidence. */
const MANY: SessionMessage[] = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, text: `invoices service note ${i}: ${'filler words here '.repeat(170)}`, toolUses: [] }))
const manyFiles = (): Record<string, string> =>
  Object.fromEntries(serializeUnits(buildUnits(MANY, { session: 'abcd1234', k: 1 })).map((part, j) => [`${DIR}/index/2026-11-24_abcd1234-1-p${j + 1}.jsonl`, part]))
const blocks = (prompt: unknown) => String(prompt).split('<evidence id="').length - 1

test('recall: a verified "not found" reads once more, wider; an answer from the wider read stands', async ($, on) => {
  const quoteFromLast = (prompt: string) => {
    const last = prompt.split('<evidence id="').at(-1)!
    const id = last.slice(0, last.indexOf('"'))
    const quote = last.slice(last.indexOf('>\n') + 2).slice(0, 24)
    return `{"answer":"it is in a later note [${id}].","citations":[{"id":"${id}","quote":"${quote}"}],"abstain":false}`
  }
  const w = engine(on, { files: manyFiles(), haiku: (_s, prompt, n) => answered(n === 1 ? abstain : quoteFromLast(prompt)) })
  const out = await recall($, 'What did the invoices service notes say?')
  expect(w.asks).toHaveLength(2)
  expect(blocks(w.asks[1]!.prompt)).toBeGreaterThan(blocks(w.asks[0]!.prompt))
  expect(estimateRequest(String(w.asks[1]!.system), String(w.asks[1]!.prompt))).toBeLessThanOrEqual(80000)
  expect(out).toContain('it is in a later note')
})

test('recall: no wider read when the first read already held everything, or when it answered', async ($, on) => {
  const w = engine(on, { files: shardFiles() })
  expect(await recall($, 'How many invoices were in batches 1-2?')).toStartWith('Not found in the archived conversation')
  expect(w.asks).toHaveLength(1)
})

// ---------------------------------------------------------------- messages queued mid-turn (0.2.9)

const queuedRow = (text: string) =>
  JSON.stringify({
    type: 'attachment',
    isSidechain: false,
    attachment: { type: 'queued_command', prompt: [{ type: 'image', source: {} }, { type: 'text', text }], origin: { kind: 'human' }, timestamp: '2026-11-24T11:59:00.000Z' },
  })
const assistantRow = JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [] } })

test('a message queued mid-turn is carried: top of the handoff, archive and facts (0.2.9)', async ($, on) => {
  const w = engine(on, { files: { [TRANSCRIPT]: [assistantRow, queuedRow('and check the parser too'), ''].join('\n') } })
  const out = messagesOf(await compact($))
  const handoff = out[0]!.text
  const section = '## Sent while Claude was working, not yet answered\nand check the parser too\n[1 image attached: not carried]'
  expect(handoff).toContain(section)
  expect(handoff.indexOf(section)).toBeLessThan(handoff.indexOf('## State of work'))
  expect(w.writes.get(`${DIR}/archive/${NAME}.txt`)).toContain(`#${INPUT.length + 1} user | and check the parser too`)
  expect(w.toasts).toEqual([`shrink: shrink 1 saved to ${DIR}/session-handoff_${NAME}.md`])
})

test('a queued message that an assistant row followed, or that a handed message holds, is not carried (0.2.9)', async ($, on) => {
  const w = engine(on, {
    files: { [TRANSCRIPT]: [queuedRow('seen already'), assistantRow, queuedRow('and add tests'), ''].join('\n') },
  })
  const out = messagesOf(await compact($))
  expect(out[0]!.text).not.toContain('Sent while Claude was working')
})

test('no transcript to read: the shrink is as before, and no problem reported (0.2.9)', async ($, on) => {
  const w = engine(on)
  const out = messagesOf(await compact($))
  expect(out[0]!.text).not.toContain('Sent while Claude was working')
  expect(w.toasts).toEqual([`shrink: shrink 1 saved to ${DIR}/session-handoff_${NAME}.md`])
})

test('a state that talks about the digest is rewritten before the handoff is written (0.2.11)', async ($, on) => {
  const w = engine(on, {
    haiku: s => answered(s === STATE_SYSTEM ? '## Goal\nparse tabs (#2)\n## Decisions and why\nnone\n## Current task and next step\nits result is not in the digest\n## Tried and failed\nnone\n## Open questions\nnone\n## Files to re-read first\nnone\n## Memory candidates\nnone' : '{"abstain":true}'),
  })
  const out = messagesOf(await compact($))
  expect(out[0]!.text).toContain('its result is not recorded')
  expect(out[0]!.text).not.toContain('not in the digest')
})


// ---------------------------------------------------------------- 0.3.0: exact lookup before the reader

test('exact lookup: a where question about an indexed item is answered by code, with no model call', async ($, on) => {
  const w = engine(on)
  await compact($)
  const asks = w.asks.length
  const text = await recall($, 'Where did we run parse.py?', ['parse.py'])
  expect(text).toStartWith('Exact lookup in the session index (by code, no model call')
  expect(text).toContain('`parse.py` (file')
  expect(text).toContain('#1:2: #2 assistant')
  expect(w.asks.length).toBe(asks)
})

test('exact lookup: a content question gets the lookup in front of the reader\'s reply', async ($, on) => {
  const w = engine(on)
  await compact($)
  const text = await recall($, 'What error did parse.py give on the tab?')
  expect(text).toStartWith('Exact lookup in the session index (by code):\n- `parse.py`')
  expect(text).toContain('Not found in the archived conversation')
  expect(text.length).toBeLessThanOrEqual(6000)
  expect(w.asks.at(-1)!.system).not.toBe(STATE_SYSTEM)
})

test('exact lookup: an unmatched lead or a missing index leaves recall to the reader', async ($, on) => {
  const w = engine(on)
  await compact($)
  expect(await recall($, 'Where is zzqq_missing?', ['zzqq_missing'])).not.toContain('Exact lookup')
  w.writes.delete(`${DIR}/items/abcd1234.jsonl`)
  expect(await recall($, 'Where did we run parse.py?', ['parse.py'])).not.toContain('Exact lookup')
})
