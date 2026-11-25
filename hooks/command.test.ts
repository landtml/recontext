// The /shrink command (design 5): its arguments, help, and /shrink now. Hooks registered on `on` stand in
// for the engine.
import type { On, SessionCompactInput, SessionMessage } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { STATE_SYSTEM } from './handoff'
import { parseShrinkArgs } from './command'

const SID = 'abcd1234-5678-90ab-cdef-000000000000'
const PROJECT = '/home/u/.claude/projects/-home-u-proj'
const DIR = `${PROJECT}/handoffs`
const NOON = Date.UTC(2026, 10, 24, 12, 0, 0)
const usage = { input_tokens: 9000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const INPUT: SessionMessage[] = [
  { role: 'user', text: 'build the parser for tabs', toolUses: [], handle: 'h1' },
  { role: 'assistant', text: 'Done.', toolUses: [], handle: 'h2' },
]

type World = { writes: Map<string, string>; beneath: SessionCompactInput[]; clock: MockClock; toasts: string[] }

function engine(on: On, reader: () => string = () => '{"abstain":true}'): World {
  const w: World = { writes: new Map(), beneath: [], toasts: [], clock: mock.clock(on, { now: NOON }) }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { tokens: 30_000, window: 1_000_000, breakdown: { autoCompactThreshold: 180_000 } as never } },
  }))
  on('session.compact', (_, e) => {
    w.beneath.push(e)
    return { messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }
  })
  on('session.id', () => ({ value: SID }))
  on('session.info', () => ({ value: { transcriptPath: `${PROJECT}/${SID}.jsonl` } }))
  on('env.get', () => ({ value: '/home/u' }))
  on('ui.toast', (_, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.register', () => ({ value: { tool: 'mcp__shrink__recall' } }))
  on('command.register', () => ({ value: { command: 'shrink' } }))
  on('model.complete', (_, e) => ({ value: { isAnswered: true, text: e.system === STATE_SYSTEM ? '## Goal\nx\n## Current task and next step\nx\n## Decisions and why\nx\n## Tried and failed\nx\n## Open questions\nx\n## Files to re-read first\nx\n## Memory candidates\nx' : reader(), usage } }))
  on('fs.write', (_, e) => {
    w.writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: w.writes.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = w.writes.get(e.path)
    return t === undefined ? { deny: `ENOENT: ${e.path}` } : { value: t }
  })
  on('fs.list', (_, e) => {
    const names = [...w.writes.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!)
    if (names.length === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: [...new Set(names)].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('session.messages', () => ({ value: INPUT }))
  return w
}

test('parseShrinkArgs: panel, now with and without a focus, help, unknown', () => {
  expect(parseShrinkArgs('')).toEqual({ kind: 'panel' })
  expect(parseShrinkArgs('  ')).toEqual({ kind: 'panel' })
  expect(parseShrinkArgs('now')).toEqual({ kind: 'now' })
  expect(parseShrinkArgs('NOW  keep the parser plan ')).toEqual({ kind: 'now', focus: 'keep the parser plan' })
  expect(parseShrinkArgs('help')).toEqual({ kind: 'help' })
  expect(parseShrinkArgs('frobnicate')).toEqual({ kind: 'unknown', word: 'frobnicate' })
})

test('/shrink now answers at once and leaves the shrink to a timer (a compaction cannot run under the command)', async ($, on) => {
  // The test kit does not run a compaction a plugin starts from a timer, so the shrink itself is checked live.
  const w = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'shrink', args: 'now keep the tab plan' } as never)
  expect(r.text).toBe('Shrinking now (focus: keep the tab plan); a toast says when it is done.')
  expect(w.writes.size).toBe(0)
  expect(w.beneath).toHaveLength(0)
})

test('/shrink help lists the options; an unknown option says so', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.command.run({ command: 'shrink', args: 'help' } as never)).text).toContain('/shrink now')
  expect((await $.command.run({ command: 'shrink', args: 'zap' } as never)).text).toContain('Unknown /shrink option "zap"')
})
