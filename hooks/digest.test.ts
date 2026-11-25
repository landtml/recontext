import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { messages as sample } from '../fixtures/sample-session'
import { buildArchive } from './archive'
import { buildDigest, renderDigest } from './digest'
import { HANDOFF_HEADER } from './prompt'

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const asst = (text: string, ...toolUses: SessionMessage['toolUses']): SessionMessage => ({ role: 'assistant', text, toolUses })

const CONVO: SessionMessage[] = [
  user('<system-reminder>secret ctx</system-reminder>fix the parser'),
  asst(
    'Looking.',
    { tool_use_id: 't1', tool: 'Read', input: { file_path: '/p/parser.py' }, text: 'BODY OF THE FILE' },
    { tool_use_id: 't2', tool: 'Bash', input: { command: 'python3 x.py' }, text: 'Exit code 1\nTraceback\nValueError: tab', isError: true },
  ),
  user('<task-notification>done</task-notification>'),
  asst('Fixed it.'),
]

test('your words, Claude\'s words and one line per tool call; results only as a failure\'s first line', () => {
  expect(buildDigest(CONVO, 100000)).toBe(
    [
      '## Conversation',
      '#1 user: fix the parser',
      '#2 assistant: Looking.',
      '#2 tool Read: /p/parser.py',
      '#2 tool Bash: python3 x.py → error: ValueError: tab',
      '#4 assistant: Fixed it.',
    ].join('\n'),
  )
})

test('an earlier handoff\'s state comes first; its facts are left out', () => {
  const prior = user(`${HANDOFF_HEADER}\n(This is shrink 5 of this session. Everything before this point was shrunk.)\n\n## State of work\n## Goal\nship it\n\n# Handoff facts (exact, extracted by code)\n- lots`)
  const d = buildDigest([prior, ...CONVO], 100000)
  // the title and "This is shrink 5" line are left out (0.2.4): Haiku copied that number onto new refs
  expect(d).toStartWith(`## Previous state\n## State of work\n## Goal\nship it\n\n## Conversation\n`)
  expect(d).not.toContain('This is shrink')
  expect(d).not.toContain('lots')
  expect(d).toContain('#2 user: fix the parser')
})

test('long texts are cut: user at 8,000 chars, assistant at 6,000, with a marker saying how much is left (0.2.8)', () => {
  const d = buildDigest([user('u'.repeat(9000)), asst('a'.repeat(7500)), asst('b'.repeat(5000))], 100000)
  expect(d).toContain(`#1 user: ${'u'.repeat(8000)}…[+1000 chars, full text archived]`)
  expect(d).toContain(`#2 assistant: ${'a'.repeat(6000)}…[+1500 chars, full text archived]`)
  expect(d).toContain(`#3 assistant: ${'b'.repeat(5000)}`)
  expect(d).not.toContain('u'.repeat(8001))
  expect(d).not.toContain(`${'b'.repeat(5000)}…`)
})

test('over budget: tool lines go first, then Claude\'s words, then the user\'s, oldest first', () => {
  const msgs = [
    user('first ask'),
    asst('first reply', { tool_use_id: 'a', tool: 'Bash', input: { command: 'one' }, text: 'ok' }),
    user('second ask'),
    asst('second reply', { tool_use_id: 'b', tool: 'Bash', input: { command: 'two' }, text: 'ok' }),
  ]
  const full = buildDigest(msgs, 100000)
  const noTools = buildDigest(msgs, full.length - 1)
  expect(noTools).toContain('#4 tool Bash: two')
  expect(noTools).not.toContain('#2 tool Bash: one')
  const userOnly = buildDigest(msgs, '## Conversation\n#1 user: first ask\n#3 user: second ask'.length)
  expect(userOnly).toBe('## Conversation\n#1 user: first ask\n#3 user: second ask')
  for (const max of [10, 40, 80, 120]) expect(buildDigest(msgs, max).length).toBeLessThanOrEqual(max)
})

test('deterministic', () => {
  expect(buildDigest(sample, 50000)).toBe(buildDigest(sample, 50000))
})

// 0.2.8: 0.42 with the 8,000/6,000 caps (0.35 at 4,000/2,000); the token budget still bounds what Haiku gets.
test('the sample fixture\'s digest is under 45% of its archive', () => {
  const ratio = buildDigest(sample, 10_000_000).length / buildArchive(sample).length
  expect(ratio).toBeLessThan(0.45)
})

test('a merge digest: previous state, then the notes on older parts, then the latest conversation', () => {
  const d = renderDigest('## Goal\nship', [{ kind: 'user', n: 90, text: '#90 user: now' }], [
    { part: 1, of: 2, first: 1, last: 40, text: '## Facts\nport 8080 (#12)' },
    { part: 2, of: 2, first: 41, last: 89, text: '## Facts\nport 9090 (#60)' },
  ])
  expect(d).toBe(
    '## Previous state\n## Goal\nship\n\n## Notes from earlier parts\n### Part 1 of 2 (#1–#40)\n## Facts\nport 8080 (#12)\n\n' +
      '### Part 2 of 2 (#41–#89)\n## Facts\nport 9090 (#60)\n\n## Conversation\n#90 user: now',
  )
})
