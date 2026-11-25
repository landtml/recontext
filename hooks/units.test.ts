import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { messages as sample } from '../fixtures/sample-session'
import { HANDOFF_HEADER } from './prompt'
import { buildUnits, entitiesOf, parseUnits, serializeUnits, type Unit } from './units'

const AT = { session: 'abcd1234', k: 2 }
const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const CONVO: SessionMessage[] = [
  user('<system-reminder>ctx</system-reminder>fix the parser in /p/parser.py'),
  {
    role: 'assistant',
    text: 'Looking at it.',
    toolUses: [
      { tool_use_id: 't1', tool: 'Bash', input: { command: 'python3 /p/parser.py --check' } },
      { tool_use_id: 't2', tool: 'Read', input: { file_path: '/p/parser.py' }, text: '1\tdef parse():' },
    ],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 't1', text: 'Exit code 1\nValueError: tab at line 3', isError: true }],
  },
  user('<task-notification>done</task-notification>'),
  user(`${HANDOFF_HEADER}\n## State of work\n## Goal\nship the parser`),
  { role: 'assistant', text: '', toolUses: [] },
]

test('one unit per user text, assistant text and tool call; refs carry session, k and line', () => {
  const units = buildUnits(CONVO, AT)
  expect(units.map(u => [u.ref, u.kind])).toEqual([
    ['abcd1234-2#1', 'user'],
    ['abcd1234-2#2', 'assistant'],
    ['abcd1234-2#2.1', 'tool'],
    ['abcd1234-2#2.2', 'tool'],
    ['abcd1234-2#5', 'handoff'],
  ])
  expect(units[0]).toMatchObject({ session: 'abcd1234', k: 2, n: 1, text: 'fix the parser in /p/parser.py' })
})

test('a tool unit holds the call and its result; the error comes from the result row', () => {
  const [, , bash, read] = buildUnits(CONVO, AT) as Unit[]
  expect(bash!.tool).toBe('Bash')
  expect(bash!.toolUseId).toBe('t1')
  expect(bash!.isError).toBe(true)
  expect(bash!.text).toBe('Bash: python3 /p/parser.py --check\nExit code 1\nValueError: tab at line 3')
  expect(read!.isError).toBeUndefined()
  expect(read!.text).toBe('Read: {"file_path":"/p/parser.py"}\n1\tdef parse():')
  expect(read!.entities).toContain('/p/parser.py')
})

// An archived recall answer once outranked the raw ScheduleWakeup record as "tool" output; a recall answer is a summary, so it ranks as one.
test('a recall answer is indexed as a summary (handoff), not as tool output', () => {
  const units = buildUnits(
    [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'mcp__shrink__recall', input: { question: 'which prompt?' }, text: 'Recall (...): Both runs were given the same prompt.' }] }],
    AT,
  )
  expect(units.map(u => [u.kind, u.tool])).toEqual([['handoff', 'mcp__shrink__recall']])
})

test('a long tool result is cut at 8,000 chars with a pointer to the archive line', () => {
  const long: SessionMessage[] = [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Bash', input: { command: 'cat big' }, text: 'y'.repeat(9000) }] },
  ]
  const [unit] = buildUnits(long, AT)
  expect(unit!.text).toBe(`Bash: cat big\n${'y'.repeat(8000)}…[+1000 chars; full: archive #1]`)
})

test('entitiesOf finds paths, URLs and error names, each once', () => {
  const e = entitiesOf('edit /p/a.py then curl https://x.io/y; ValueError: bad, again /p/a.py and tools/fix.py, notes.md')
  expect(e).toContain('/p/a.py')
  expect(e).toContain('https://x.io/y')
  expect(e).toContain('ValueError')
  expect(e).toContain('tools/fix.py')
  expect(e).toContain('notes.md')
  expect(e.filter(x => x === '/p/a.py')).toHaveLength(1)
  expect(e.some(x => x.startsWith('//x.io'))).toBe(false)
})

test('shards stay under the byte limit and round-trip', () => {
  const units = buildUnits(CONVO, AT)
  const lineBytes = Math.max(...units.map(u => new TextEncoder().encode(`${JSON.stringify(u)}\n`).length))
  const shards = serializeUnits(units, lineBytes * 2)
  expect(shards.length).toBeGreaterThan(1)
  for (const s of shards) expect(new TextEncoder().encode(s).length).toBeLessThanOrEqual(lineBytes * 2)
  expect(shards.flatMap(parseUnits)).toEqual(units)
})

test('parseUnits skips lines that are not units', () => {
  const good = JSON.stringify(buildUnits(CONVO, AT)[0])
  expect(parseUnits(`${good}\nnot json\n{"x":1}\n\n`)).toHaveLength(1)
})

test('the sample fixture: one tool unit per tool use', () => {
  const uses = sample.reduce((n, m) => n + (m.toolUses ?? []).length, 0)
  const units = buildUnits(sample, { session: 'c0ffee12', k: 1 })
  expect(units.filter(u => u.kind === 'tool')).toHaveLength(uses)
  expect(units.every(u => u.text.length > 0)).toBe(true)
})

test('parseUnits ranks a recall answer from an older shard as a summary too', () => {
  const old = { ref: 'a-1#2.1', session: 'a', k: 1, n: 2, kind: 'tool', tool: 'mcp__shrink__recall', text: 'x', entities: [] }
  expect(parseUnits(`${JSON.stringify(old)}\n`)[0]!.kind).toBe('handoff')
})

test('a tool unit knows the archive line of its result, for refs that cite the result (0.2.4)', () => {
  // regression: "what did #7 print" missed, as line 7 is the result of the call at line 6
  const units = buildUnits(CONVO, AT)
  expect(units.find(u => u.ref === 'abcd1234-2#2.1')).toMatchObject({ n: 2, resultN: 3 })
  // a result carried on the call itself sits on the call's line
  expect(units.find(u => u.ref === 'abcd1234-2#2.2')?.resultN).toBeUndefined()
})
