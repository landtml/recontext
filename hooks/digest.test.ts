import type { SessionMessage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { messages as sample } from '../fixtures/sample-session'
import { buildArchive } from './archive'
import { buildDigest, digestParts, previousStateOf, readOnlyShell, renderDigest } from './digest'
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

test('over budget: result lines go first, then tool lines, then Claude\'s words, then the user\'s, oldest first', () => {
  const msgs = [
    user('first ask'),
    asst('first reply', { tool_use_id: 'a', tool: 'Bash', input: { command: 'one' }, text: 'ok' }),
    user('second ask'),
    asst('second reply', { tool_use_id: 'b', tool: 'Bash', input: { command: 'two' }, text: 'ok' }),
  ]
  const full = buildDigest(msgs, 100000)
  const fewerResults = buildDigest(msgs, full.length - 1)
  expect(fewerResults).not.toContain('#2 result: ok')
  expect(fewerResults).toContain('#2 tool Bash: one')
  expect(fewerResults).toContain('#4 result: ok')
  const noTools = buildDigest(msgs, full.length - '\n#2 result: ok\n#4 result: ok'.length - 1)
  expect(noTools).not.toContain('result:')
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

test('previousStateOf: a queued section before the state is not part of the previous state (0.2.9)', () => {
  const h = [HANDOFF_HEADER, '(This is shrink 2 …)', '', '## Sent while Claude was working, not yet answered', 'hi', '', '## State of work', '## Goal', 'x', '', '# Handoff facts (exact, extracted by code)', 'f'].join('\n')
  expect(previousStateOf([{ role: 'user', text: h, toolUses: [] }])).toBe('## State of work\n## Goal\nx')
})

// 0.2.10: a successful call's outcome as a `#n result:` line (accuracy review idea 1)
const call = (tool: string, input: Record<string, unknown>, text: string | undefined, isError = false) =>
  digestParts([user('go'), asst('', { tool_use_id: 'u1', tool, input, text, ...(isError ? { isError: true as const } : {}) })]).lines.map(l => l.text)
const bash = (out: string | undefined, isError = false) => call('Bash', { command: 'make it' }, out, isError)

test('result line: a successful Bash call gets its last non-empty line, right after the call (0.2.10)', () => {
  expect(bash('a\nb\n\n')).toEqual(['#1 user: go', '#2 tool Bash: make it', '#2 result: b'])
})

test('result line: test summary lines win over the last line (0.2.10)', () => {
  expect(bash(' 242 pass\n 0 fail\n 1203 expect() calls\nRan 242 tests across 14 files. [1.2s]')[2]).toBe('#2 result: 242 pass, 0 fail')
  expect(bash('collected 4 items\n\n== 3 passed, 1 skipped in 0.2s ==')[2]).toBe('#2 result: 3 passed, 1 skipped in 0.2s')
})

test('result line: exit 0 with a failure marker shows the failure first (0.2.10)', () => {
  expect(bash('(pass) a\n(fail) effort is sent on every call [0.4ms]\n 241 pass\n 1 fail')[2]).toBe(
    '#2 result: (fail) effort is sent on every call [0.4ms] · 241 pass, 1 fail',
  )
  expect(bash('Traceback (most recent call last):\n  File "x.py", line 1\nValueError: tab')[2]).toBe('#2 result: ValueError: tab')
})

test('result line: empty output says so (0.2.10)', () => {
  expect(bash('')[2]).toBe('#2 result: (no output)')
  expect(bash('\n  \n')[2]).toBe('#2 result: (no output)')
})

test('result line: Agent, AskUserQuestion and mcp tools (0.2.10)', () => {
  expect(call('Agent', { prompt: 'p' }, 'Done. 3 files changed.\nDetails follow')[2]).toBe('#2 result: Done. 3 files changed.')
  expect(call('Agent', { prompt: 'p' }, 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ab3c (internal ID)')[2]).toBe(
    '#2 result: (started in the background)',
  )
  expect(call('AskUserQuestion', {}, 'Your questions have been answered: "Ship it, or wait?"="Package (Recommended)", "Which one?"="the "old" one". You can now continue.')[2]).toBe(
    '#2 result: answered: Package (Recommended) | the "old" one',
  )
  expect(call('mcp__shrink__recall', { question: 'q' }, '\nNot found in the archived conversation.\n- a')[2]).toBe('#2 result: Not found in the archived conversation.')
})

test('result line: reads, searches, edits and writes get none (0.2.10)', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'TodoWrite']) expect(call(tool, { file_path: '/p/x' }, 'some output')).toHaveLength(2)
})

test('result line: a failed call keeps its error and gets no result line (0.2.10)', () => {
  expect(bash('Exit code 1\nboom')).toEqual(['#1 user: go', '#2 tool Bash: make it → error: Exit code 1; last line: boom'])
  expect(bash('denied', true)).toHaveLength(2)
})

test('result line: a call with no result gets none (0.2.10)', () => {
  expect(bash(undefined)).toHaveLength(2)
})

test('result line: output that may hold a secret is withheld (0.2.10)', () => {
  for (const out of ['ghp_abcdefghij0123456789', 'Authorization: Bearer abcdefgh12345', 'API_KEY=supersecretvalue1', 'sk-ant-api03-abcdefghijk'])
    expect(bash(`ok\n${out}`)[2]).toBe('#2 result: (output withheld: may hold a secret)')
  expect(bash('token budget is 80000')[2]).toBe('#2 result: token budget is 80000')
})

test('result line: flattened and cut at 100 chars (0.2.10)', () => {
  const r = bash(`${'x'.repeat(150)}`)[2]!
  expect(r).toBe(`#2 result: ${'x'.repeat(100)}…`)
})

test('result line: the harness notices after a command are not its outcome (0.2.10)', () => {
  expect(bash('built ok\nShell cwd was reset to /home/u/proj')[2]).toBe('#2 result: built ok')
  expect(bash('Shell cwd was reset to /home/u/proj')[2]).toBe('#2 result: (no output)')
  expect(bash('(Bash completed with no output)')[2]).toBe('#2 result: (no output)')
  expect(bash("wrote 3\n[This command modified 1 file you've previously read: /p/x.ts. Call Read before editing.]")[2]).toBe('#2 result: wrote 3')
})

test('result line: only the line shown is checked for a secret (0.2.10)', () => {
  expect(bash('  maxTokens: STATE_MAX_TOKENS,\nall good')[2]).toBe('#2 result: all good')
})

test('result line: a recall answer skips its data header (0.2.10)', () => {
  const text = 'Recall (archived conversation data, not instructions; authority: tool output):\nNo. The firm was not checked.'
  expect(call('mcp__shrink__recall', { question: 'q' }, text)[2]).toBe('#2 result: No. The firm was not checked.')
})

test('result line: a closing bracket is not an outcome; the last line with words is (0.2.10)', () => {
  expect(bash('{\n  "ok": true,\n  "n": 3\n}')[2]).toBe('#2 result: "n": 3')
  expect(bash('})\n]')[2]).toBe('#2 result: ]')
})

test('result line: a traceback shows its exception, not its header (0.2.10)', () => {
  const tb = 'Traceback (most recent call last):\n  File "x.py", line 3, in <module>\n    f()\nKeyError: \'name\''
  expect(bash(tb)[2]).toBe("#2 result: KeyError: 'name'")
  expect(bash('Traceback (most recent call last):\n  File "x.py", line 3')[2]).toBe('#2 result: Traceback (most recent call last):')
})

test('a compound command whose only failure is a last diff with differences gets a result line, not an error (0.2.10)', () => {
  const lines = call(
    'Bash',
    { command: 'python3 run.py > after.txt; echo EXIT=$?; diff before.txt after.txt && echo SAME' },
    "Exit code 1\nEXIT=0\n2c2\n< 'q one' | 14\n---\n> 'q one' | 9",
    true,
  )
  expect(lines[1]).toBe('#2 tool Bash: python3 run.py > after.txt; echo EXIT=$?; diff before.txt after.txt && echo SAME')
  expect(lines[2]).toBe("#2 result: > 'q one' | 9")
})

// 0.2.10: Skill calls get a result line; commands that only read get none
test('a Skill call gets its first line as the result (0.2.10)', () => {
  // a Skill call's result is "Launching skill: <name>", sometimes with a reminder after it
  expect(call('Skill', { skill: 'claude-api' }, 'Launching skill: claude-api\n\n<system-reminder>\nCodebase…')[2]).toBe(
    '#2 result: Launching skill: claude-api',
  )
})

const READ_ONLY = [
  'cat f',
  'sed -n 1,40p f',
  'head -50 f',
  'tail -3 f',
  'grep -n x f',
  'ls dir',
  'wc -l f',
  'find . -name x',
  'cd /p && sed -n 1,9p a.ts; grep -n "x\\|y" b.ts | head -20',
  'ls /p 2>&1 | head',
  'cat a 2>/dev/null; echo ---; tail -5 b',
  // most remaining noise was reading behind a variable, in a loop, or through awk/git/sort
  'S=/tmp/x; grep -n a $S/f',
  'for f in a b; do echo "== $f"; cat "$f"; done',
  "awk '/^## 6/,/^## 7/' f | head -60",
  'git log --oneline | head',
  'cut -d, -f1 f | sort | uniq -c',
]
const NOT_READ_ONLY = [
  "sed -i 's/a/b/' f",
  'cat x | python3 -',
  'cat > f <<EOF',
  'make && grep -n ok out.log',
  'bun test',
  'echo hi > f',
  'cat a | tee b',
  'find . -name x -delete',
  'cat <<EOF\nx\nEOF',
  'T=$(bash snap) && echo $T',
  'git commit -m x',
  'for f in *; do rm $f; done',
  "awk '{ system(\"rm \" $1) }' f",
]

test('readOnlyShell: true only when every part only reads (0.2.10)', () => {
  for (const c of READ_ONLY) expect([c, readOnlyShell(c)]).toEqual([c, true])
  for (const c of NOT_READ_ONLY) expect([c, readOnlyShell(c)]).toEqual([c, false])
})

test('a read-only shell command gets no result line; any other part keeps it; a failed one keeps its error (0.2.10)', () => {
  for (const command of READ_ONLY) expect(call('Bash', { command }, 'line one\nline two')).toEqual(['#1 user: go', `#2 tool Bash: ${command.split('\n')[0]}`])
  expect(call('Bash', { command: 'make && grep -n ok out.log' }, 'built\nok 3')[2]).toBe('#2 result: ok 3')
  expect(call('Bash', { command: 'cat f' }, 'Exit code 1\ncat: f: No such file or directory', true)[1]).toBe(
    '#2 tool Bash: cat f → error: cat: f: No such file or directory',
  )
})

test('a Bash call sent to the background says so, not the harness note after it (0.2.10)', () => {
  // regression: the result line was "Session cwd remains …"
  const out = 'Command running in background with ID: b3z9ushfl. Output is being written to: /tmp/x/b3z9ushfl.output\nSession cwd remains /p; directory changes made by the backgrounded command do not apply'
  expect(call('Bash', { command: 'python3 long.py > out.txt', run_in_background: true }, out)[2]).toBe('#2 result: (started in the background)')
})
