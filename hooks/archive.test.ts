import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { RESULT_CAP, WRITE_INPUT_CAP, buildArchive, oneLine } from './archive'

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const CONVO: SessionMessage[] = [
  user('fix the parser\nplease, it breaks on tabs'),
  {
    role: 'assistant',
    text: 'Looking.',
    toolUses: [
      { tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'python3 tools/x.py --flag' } },
      { tool_use_id: 'toolu_2', tool: 'Read', input: { file_path: '/p/parser.py' } },
    ],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [
      { tool_use_id: 'toolu_1', text: 'Exit code 2\nTraceback\nValueError: tab', isError: true },
      { tool_use_id: 'toolu_2', text: '1\tdef parse():', isError: false },
    ],
  },
  { role: 'assistant', text: 'Fixed.', toolUses: [] },
]

const lines = (s: string) => s.split('\n').filter(l => l !== '')

test('oneLine replaces every kind of line break with ⏎', () => {
  expect(oneLine('a\nb\r\nc\rd\u2028e\u2029f')).toBe('a⏎b⏎c⏎d⏎e⏎f')
})

test('one line per message, plus one per tool result, numbered from 1', () => {
  const out = buildArchive(CONVO)
  expect(out.endsWith('\n')).toBe(true)
  expect(lines(out)).toEqual([
    '#1 user | fix the parser⏎please, it breaks on tabs',
    '#2 assistant | Looking. ⟦tool Bash: python3 tools/x.py --flag⟧ ⟦tool Read: {"file_path":"/p/parser.py"}⟧',
    '#3 tool Bash error | Exit code 2⏎Traceback⏎ValueError: tab (tool_use_id toolu_1)',
    '#3 tool Read ok | 1\tdef parse(): (tool_use_id toolu_2)',
    '#4 assistant | Fixed.',
  ])
})

test('no raw newline survives inside a line, whatever the input holds', () => {
  const nasty: SessionMessage[] = [
    user('a\nb\r\nc'),
    {
      role: 'assistant',
      text: 'x\ny',
      toolUses: [{ tool_use_id: 't', tool: 'Bash', input: { command: 'echo 1\necho 2' }, text: 'l1\nl2' }],
    },
  ]
  const out = buildArchive(nasty)
  for (const line of lines(out)) expect(line).toMatch(/^#\d+ (user|assistant|tool \S+ (ok|error)) \| /)
  expect(out.split('\n').filter(l => l !== '')).toHaveLength(3)
})

test('tool results are cut to 1,500 chars with the full-text pointer', () => {
  const long = 'z'.repeat(RESULT_CAP + 500)
  const out = buildArchive([
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_big', tool: 'Grep', input: { pattern: 'x' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_big', text: long, isError: false }] },
  ])
  const line = lines(out)[1]!
  expect(line).toBe(
    `#2 tool Grep ok | ${'z'.repeat(RESULT_CAP)}… (full: transcript, tool_use_id toolu_big)`,
  )
  expect(RESULT_CAP).toBe(1500)
})

test('Write and Edit inputs are cut to 300 chars; the path stays whole', () => {
  const body = 'q'.repeat(WRITE_INPUT_CAP + 100)
  const out = buildArchive([
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'w', tool: 'Write', input: { file_path: '/p/a.py', content: body } },
        { tool_use_id: 'e', tool: 'Edit', input: { file_path: '/p/b.py', old_string: body, new_string: 'n' } },
      ],
    },
  ])
  expect(WRITE_INPUT_CAP).toBe(300)
  const cut = `${'q'.repeat(WRITE_INPUT_CAP)}…[+100]`
  expect(out).toContain(`⟦tool Write: {"file_path":"/p/a.py","content":"${cut}"}⟧`)
  expect(out).toContain(`⟦tool Edit: {"file_path":"/p/b.py","old_string":"${cut}","new_string":"n"}⟧`)
})

test('other inputs and user text are not truncated', () => {
  const longCmd = `echo ${'c'.repeat(3000)}`
  const longText = 'u'.repeat(6000)
  const out = buildArchive([
    user(longText),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: longCmd } }] },
  ])
  expect(out).toContain(`#1 user | ${longText}\n`)
  expect(out).toContain(`⟦tool Bash: ${longCmd}⟧`)
})

test('a result found only on the tool use is written after the assistant line', () => {
  const out = buildArchive([
    {
      role: 'assistant',
      text: 'go',
      toolUses: [{ tool_use_id: 'only', tool: 'WebFetch', input: { url: 'https://a.b' }, text: 'page', isError: true }],
    },
  ])
  expect(lines(out)).toEqual([
    '#1 assistant | go ⟦tool WebFetch: {"url":"https://a.b"}⟧',
    '#1 tool WebFetch error | page (tool_use_id only)',
  ])
})

test('a result whose call is not in the slice is named "?"; empty messages keep their number', () => {
  const out = buildArchive([
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'gone', text: 'r', isError: false }] },
    { role: 'assistant', text: '', toolUses: [] },
  ])
  expect(lines(out)).toEqual(['#1 tool ? ok | r (tool_use_id gone)', '#2 assistant | '])
})

test('empty conversation gives an empty archive; same input gives the same output', () => {
  expect(buildArchive([])).toBe('')
  expect(buildArchive(CONVO)).toBe(buildArchive(CONVO))
})
