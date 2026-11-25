import { expect, test } from 'claude-code/testing'
import { queuedMessages, queuedSection, unansweredQueued } from './queued'

const row = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, uuid: 'u', ...o })
const asst = row({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
const toolResult = row({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } })
const queued = (prompt: unknown, origin: Record<string, unknown> = { kind: 'human' }) =>
  row({
    type: 'attachment',
    attachment: { type: 'queued_command', prompt, origin, commandMode: 'prompt', timestamp: '2026-01-01T12:00:00.000Z' },
  })
const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }

test('unansweredQueued: a queued_command after the last assistant row is returned (0.2.9)', () => {
  const tail = [asst, queued([IMG, { type: 'text', text: 'and check the parser too' }]), toolResult].join('\n')
  expect(unansweredQueued(tail)).toEqual([
    { text: 'and check the parser too', images: 1, origin: 'human', timestamp: '2026-01-01T12:00:00.000Z' },
  ])
})

test('unansweredQueued: a queued_command followed by an assistant row is not (0.2.9)', () => {
  expect(unansweredQueued([queued([{ type: 'text', text: 'then rebuild' }]), asst].join('\n'))).toEqual([])
})

test('unansweredQueued: a cut first line, bad JSON and side chains are skipped (0.2.9)', () => {
  const sub = JSON.stringify({ isSidechain: true, type: 'assistant', message: {} })
  const tail = ['ext":"half a row"}]}}', '{not json', asst, queued('<task-notification>\n<status>completed</status>\n</task-notification>', { kind: 'task-notification' }), sub, ''].join('\n')
  expect(unansweredQueued(tail)).toEqual([
    { text: '<task-notification>\n<status>completed</status>\n</task-notification>', images: 0, origin: 'task-notification', timestamp: '2026-01-01T12:00:00.000Z' },
  ])
})

test('unansweredQueued: a compact_boundary clears earlier ones; image-only and empty prompts (0.2.9)', () => {
  const boundary = row({ type: 'system', subtype: 'compact_boundary' })
  expect(unansweredQueued([queued([{ type: 'text', text: 'old' }]), boundary, queued([IMG]), queued([])].join('\n'))).toEqual([
    { text: '', images: 1, origin: 'human', timestamp: '2026-01-01T12:00:00.000Z' },
  ])
  expect(unansweredQueued('')).toEqual([])
})

test('queuedSection: each message verbatim, images noted, task notifications labelled (0.2.9)', () => {
  expect(queuedSection([])).toBe('')
  expect(
    queuedSection([
      { text: 'and check the parser too', images: 1, origin: 'human' },
      { text: '', images: 2, origin: 'human' },
      { text: '<task-notification>x</task-notification>', images: 0, origin: 'task-notification' },
    ]),
  ).toBe(
    [
      '## Sent while Claude was working, not yet answered',
      'and check the parser too',
      '[1 image attached: not carried]',
      '',
      '[2 images attached: not carried]',
      '',
      '(task notification) <task-notification>x</task-notification>',
    ].join('\n'),
  )
})

test('queuedSection: a long message is cut with its length (0.2.9)', () => {
  const s = queuedSection([{ text: 'a'.repeat(5000), images: 0, origin: 'human' }])
  expect(s).toContain('… [cut at 4000 of 5000 chars]')
  expect(s.length).toBeLessThan(4200)
})

test('queuedMessages: user messages for the archive, index, digest and facts (0.2.9)', () => {
  expect(
    queuedMessages([
      { text: 'and check the parser too', images: 1, origin: 'human' },
      { text: '<task-notification>x</task-notification>', images: 0, origin: 'task-notification' },
    ]),
  ).toEqual([
    { role: 'user', text: 'and check the parser too\n[1 image attached: not carried]', toolUses: [] },
    { role: 'user', text: '<task-notification>x</task-notification>', toolUses: [] },
  ])
})
