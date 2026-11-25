// The bar and the /shrink panel (design 7), drawn after real events: session start, a fill
// change, a shrink, and a recall. Hooks registered on `on` stand in for the engine.
import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { STATE_SYSTEM } from './handoff'
import { hhmm } from './view'

const NOON = Date.UTC(2026, 10, 24, 12, 0, 0)
const INPUT: SessionMessage[] = [
  { role: 'user', text: 'build the parser', toolUses: [], handle: 'h1' },
  { role: 'assistant', text: 'Done.', toolUses: [], handle: 'h2' },
]
const BAND = {
  plugin: 'shrink',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const
const PANE = {
  plugin: 'shrink',
  component: 'Pane',
  requestId: 'shrink',
  props: { title: 'Shrink', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function engine(on: On): { opened: unknown[] } {
  const w = { opened: [] as unknown[] }
  mock.clock(on, { now: NOON })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { tokens: 30_000, window: 1_000_000, breakdown: { autoCompactThreshold: 180_000 } as never } },
  }))
  on('session.id', () => ({ value: 'abcd1234-0000' }))
  on('session.info', () => ({ value: { transcriptPath: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'mcp__shrink__recall' } }))
  on('command.register', () => ({ value: { command: 'shrink' } }))
  on('ui.open', (_, e) => {
    w.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('model.complete', (_, e) => ({
    value: { isAnswered: true, text: e.system === STATE_SYSTEM ? '## Goal\nx\n## Current task and next step\nx\n## Decisions and why\nx\n## Tried and failed\nx\n## Open questions\nx\n## Files to re-read first\nx\n## Memory candidates\nx' : '{"abstain":true}', usage: { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }))
  return w
}

const measure = ($: { session: { measure: (i: never) => Promise<unknown> } }, tokens: number) =>
  $.session.measure({ context: { tokens, window: 1_000_000, usd: 0, id: 'c' }, rateLimits: [], changed: ['context'] } as never)

test('the bar shows the context against the threshold from the start', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 112_000)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const row = await ui.find({ type: 'Text', text: /shrink ▸/ })
    expect(row?.text).toBe('shrink ▸ context 112k / 180k ▓▓▓▓▓▓░░░░ · no shrinks yet')
    await ui.unmount()
  }
})

test('the bar steps aside for a survey and when collapsed', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const props of [{ ...BAND.props, hasSurvey: true }, { ...BAND.props, isCollapsed: true }]) {
    const ui = await $.ui.mount({ ...BAND, props, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /shrink ▸/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('after a shrink and a recall, the bar counts them and the panel lists them', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($, 176_000)
  await $.session.compact({ trigger: 'auto', messages: INPUT })
  await measure($, 9_000)
  await $.tool.call({ tool: 'mcp__shrink__recall', question: 'why tabs?' } as never)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /shrink ▸/ }))?.text).toBe(
    'shrink ▸ context 9k / 180k ▓░░░░░░░░░ · 1 shrink (Haiku, ~0 s each) · 1 recall (0 answered)',
  )
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect((await pane.find({ type: 'Text', text: /^#1 / }))?.text).toBe(`#1 ${hhmm(NOON)}  auto  176k → 9k  Haiku 1.6k tok  0.0 s`)
  expect((await pane.find({ type: 'Text', text: /why tabs/ }))?.text).toBe(`${hhmm(NOON)}  "why tabs?" → unavailable`)
  await pane.unmount()
})

test('the panel is empty-handed before anything happened, and never opens by itself', async ($, on) => {
  const w = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(w.opened).toEqual([])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /No shrinks yet/ }))?.text).toBe('No shrinks yet in this session.')
  await pane.unmount()
})
