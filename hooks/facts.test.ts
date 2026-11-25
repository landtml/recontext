import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { buildArchive } from './archive'
import { HEADER, answersOf, buildFacts, commandKey, firstErrorLine, noMatchExit, personText, recipeForm, shellWrites, type FactsOptions } from './facts'
import { HANDOFF_HEADER } from './prompt'

const OPTS: FactsOptions = {
  verbatimUserMessages: 5,
  factsBudgetChars: 20000,
  archivePath: '/h/archive/2026-11-23_abcd1234-1.txt',
  transcriptPath: '/p/abcd1234.jsonl',
}

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const call = (
  tool: string,
  input: Record<string, unknown>,
  out: Partial<ToolUseSummary> = {},
  id = `toolu_${tool}_${JSON.stringify(input).length}`,
): ToolUseSummary => ({ tool_use_id: id, tool, input, ...out })
const asst = (...toolUses: ToolUseSummary[]): SessionMessage => ({ role: 'assistant', text: 'ok', toolUses })

/** The lines of one `## <title>` section, heading excluded. */
const section = (facts: string, title: string): string[] => {
  const start = facts.indexOf(`\n## ${title}`)
  if (start < 0) return []
  const body = facts.slice(start + 1).split('\n').slice(1)
  const end = body.findIndex(l => l.startsWith('## ') || l === '---')
  return (end < 0 ? body : body.slice(0, end)).filter(l => l !== '')
}

// ---------------------------------------------------------------- user messages

test('personText strips <system-reminder> blocks and keeps the words', () => {
  expect(personText('<system-reminder>\nx\n</system-reminder>\nfix it\n<system-reminder>y</system-reminder>')).toBe('fix it')
  expect(personText('only <system-reminder>a</system-reminder> words')).toBe('only  words')
})

test('personText drops rows the engine made, and shows a slash command as typed', () => {
  expect(personText('<task-notification>\n<task-id>a</task-id></task-notification>')).toBeUndefined()
  expect(personText('<local-command-caveat>Caveat</local-command-caveat>')).toBeUndefined()
  expect(personText('<local-command-stdout>Set model</local-command-stdout>')).toBeUndefined()
  expect(personText('This session is being continued from a previous conversation that ran out of context.')).toBeUndefined()
  expect(personText('Base directory for this skill: /tmp/x\n\n# Skill')).toBeUndefined()
  expect(personText('[Image: source: /tmp/a.png]')).toBeUndefined()
  expect(personText('<system-reminder>only this</system-reminder>')).toBeUndefined()
  expect(personText('')).toBeUndefined()
  expect(
    personText('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the plan</command-args>'),
  ).toBe('/compact keep the plan')
  expect(personText('<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>')).toBe('/clear')
})

test('the last N user messages are verbatim, newest last, with their archive line', () => {
  const msgs: SessionMessage[] = []
  for (let i = 1; i <= 7; i++) msgs.push(user(`message ${i}\nsecond line ${i}`), asst())
  const facts = buildFacts(msgs, OPTS)
  const verbatim = section(facts, "The user's last messages, verbatim")
  expect(verbatim).toEqual([
    '### #5', 'message 3', 'second line 3',
    '### #7', 'message 4', 'second line 4',
    '### #9', 'message 5', 'second line 5',
    '### #11', 'message 6', 'second line 6',
    '### #13', 'message 7', 'second line 7',
  ])
  expect(section(facts, 'Earlier messages')).toEqual(['- #1 message 1 second line 1', '- #3 message 2 second line 2'])
})

test('reminders and machine rows never reach the facts; N comes from the options', () => {
  const msgs = [
    user('real one'),
    user('<task-notification>agent done</task-notification>'),
    user('real two<system-reminder>secret context</system-reminder>'),
  ]
  const facts = buildFacts(msgs, { ...OPTS, verbatimUserMessages: 1 })
  expect(section(facts, "The user's last messages, verbatim")).toEqual(['### #3', 'real two'])
  expect(section(facts, 'Earlier messages')).toEqual(['- #1 real one'])
  expect(facts).not.toContain('secret context')
  expect(facts).not.toContain('agent done')
})

test('a verbatim message is cut at 4,000 chars, pointing at its archive line', () => {
  const facts = buildFacts([user('v'.repeat(5000))], OPTS)
  expect(facts).toContain(`${'v'.repeat(4000)}… [cut at 4000 of 5000 chars: archive #1]`)
  expect(facts).not.toContain('v'.repeat(4001))
})

test('earlier messages: 160 chars each, at most 40, the oldest dropped with "+N more"', () => {
  const msgs: SessionMessage[] = []
  for (let i = 1; i <= 50; i++) msgs.push(user(`m${i} ${'w'.repeat(300)}`))
  const facts = buildFacts(msgs, { ...OPTS, verbatimUserMessages: 5 })
  const earlier = section(facts, 'Earlier messages')
  expect(earlier[0]).toBe('+5 more: grep the archive')
  expect(earlier).toHaveLength(41)
  expect(earlier[1]).toStartWith('- #6 m6 ')
  expect(earlier[40]).toStartWith('- #45 m45 ')
  for (const line of earlier.slice(1)) {
    const text = line.replace(/^- #\d+ /, '')
    expect(text.length).toBeLessThanOrEqual(160)
    expect(text.endsWith('…')).toBe(true)
  }
})

// ---------------------------------------------------------------- tool facts

test('files touched: actions R/W/E with counts, NotebookEdit as an edit', () => {
  const facts = buildFacts(
    [
      asst(
        call('Read', { file_path: '/p/a.py' }, {}, 'r1'),
        call('Read', { file_path: '/p/a.py' }, {}, 'r2'),
        call('Edit', { file_path: '/p/a.py', old_string: 'x', new_string: 'y' }, {}, 'e1'),
        call('Write', { file_path: '/p/b.md', content: 'z' }, {}, 'w1'),
        call('NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 's' }, {}, 'n1'),
        call('Grep', { pattern: 'x', path: '/p' }, {}, 'g1'),
      ),
    ],
    OPTS,
  )
  // ordered by last touch, oldest first
  expect(section(facts, 'Files touched')).toEqual(['- /p/a.py  R2 E1', '- /p/b.md  W1', '- /p/n.ipynb  E1'])
})

test('files touched: at most 60 paths, the least recently touched dropped', () => {
  const uses = Array.from({ length: 65 }, (_, i) => call('Read', { file_path: `/f/${i}` }, {}, `r${i}`))
  uses.push(call('Edit', { file_path: '/f/0' }, {}, 'again')) // /f/0 is now the newest
  const files = section(buildFacts([asst(...uses)], OPTS), 'Files touched')
  expect(files[0]).toBe('+5 more: grep the archive')
  expect(files).toHaveLength(61)
  expect(files[1]).toBe('- /f/6  R1')
  expect(files[60]).toBe('- /f/0  R1 E1')
})

test('failed commands: errors and non-zero exits, with the first error line', () => {
  const facts = buildFacts(
    [
      user('go'),
      asst(
        call('Bash', { command: 'pytest -q' }, { isError: true, text: 'Exit code 1\n\ncollected 3\nE   AssertionError: 2 != 3\nFAILED t.py' }, 'b1'),
        call('Bash', { command: 'ls' }, { text: 'a\nb' }, 'b2'),
        call('Read', { file_path: '/p/missing' }, { isError: true, text: 'File does not exist.' }, 'r1'),
        call('Bash', { command: 'make' }, { text: 'Exit code 2\nmake: *** No rule to make target' }, 'b3'),
      ),
    ],
    OPTS,
  )
  expect(section(facts, 'Failed commands and errors')).toEqual([
    '- #2 Bash: pytest -q → E   AssertionError: 2 != 3',
    '- #2 Read: /p/missing → File does not exist.',
    '- #2 Bash: make → Exit code 2; last line: make: *** No rule to make target',
  ])
})

test('failed commands: the outcome is read from the tool_result row too', () => {
  const facts = buildFacts(
    [
      asst(call('Bash', { command: 'false' }, {}, 'b1')),
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b1', text: 'Exit code 1', isError: true }] },
    ],
    OPTS,
  )
  expect(section(facts, 'Failed commands and errors')).toEqual(['- #1 Bash: false → Exit code 1; no output'])
})

test('failed commands: at most 30, oldest dropped; long commands cut', () => {
  const uses = Array.from({ length: 33 }, (_, i) =>
    call('Bash', { command: `cmd${i} ${'a'.repeat(400)}` }, { isError: true, text: `Exit code 1\nerr ${i}` }, `b${i}`),
  )
  const failed = section(buildFacts([asst(...uses)], OPTS), 'Failed commands and errors')
  expect(failed[0]).toBe('+3 more: grep the archive')
  expect(failed).toHaveLength(31)
  expect(failed[1]).toStartWith('- #1 Bash: cmd3 ')
  expect(failed[30]).toEndWith('… → err 32')
  for (const line of failed.slice(1)) expect(line.length).toBeLessThan(500)
})

test('URLs: WebFetch urls and http(s) in Bash commands, deduplicated', () => {
  const facts = buildFacts(
    [
      asst(
        call('WebFetch', { url: 'https://a.example/x', prompt: 'p' }, {}, 'w1'),
        call('Bash', { command: 'curl -s "https://b.example/api?q=1" | jq . ; echo http://c.example/.' }, {}, 'b1'),
        call('WebFetch', { url: 'https://a.example/x', prompt: 'again' }, {}, 'w2'),
      ),
    ],
    OPTS,
  )
  expect(section(facts, 'URLs fetched')).toEqual([
    '- https://b.example/api?q=1',
    '- http://c.example/',
    '- https://a.example/x',
  ])
})

test('URLs: at most 30', () => {
  const uses = Array.from({ length: 32 }, (_, i) => call('WebFetch', { url: `https://u.example/${i}` }, {}, `w${i}`))
  const urls = section(buildFacts([asst(...uses)], OPTS), 'URLs fetched')
  expect(urls[0]).toBe('+2 more: grep the archive')
  expect(urls[1]).toBe('- https://u.example/2')
  expect(urls).toHaveLength(31)
})

test('agents: description, type and agentId (from the field or the result text)', () => {
  const facts = buildFacts(
    [
      asst(
        call('Agent', { description: 'Re-rank batch 01', subagent_type: 'research-worker', prompt: 'p' }, { agentId: 'aaa111' }, 'a1'),
        call('Agent', { description: 'Explore code', prompt: 'p' }, { text: 'Async agent launched.\nagentId: bbb222 (internal ID)' }, 'a2'),
        call('Agent', { description: 'Refused', prompt: 'p' }, { isError: true, text: 'denied' }, 'a3'),
      ),
    ],
    OPTS,
  )
  expect(section(facts, 'Agents spawned')).toEqual([
    '- #1 Re-rank batch 01 [research-worker] agentId aaa111',
    '- #1 Explore code agentId bbb222',
    '- #1 Refused (no agent started)',
  ])
})

test('agents: at most 20', () => {
  const uses = Array.from({ length: 22 }, (_, i) => call('Agent', { description: `job ${i}` }, { agentId: `id${i}` }, `a${i}`))
  const agents = section(buildFacts([asst(...uses)], OPTS), 'Agents spawned')
  expect(agents[0]).toBe('+2 more: grep the archive')
  expect(agents).toHaveLength(21)
})

// ---------------------------------------------------------------- where to look, shape

test('where to look names the archive and the transcript and ends the facts', () => {
  const facts = buildFacts([user('hi')], OPTS)
  expect(section(facts, 'Where to look')).toEqual([
    '- Archive: /h/archive/2026-11-23_abcd1234-1.txt (one line per message: `#n role tool | text`)',
    '- Original transcript: /p/abcd1234.jsonl',
  ])
  expect(facts).toStartWith('# Handoff facts (exact, extracted by code)\n')
  expect(facts).toEndWith('- Original transcript: /p/abcd1234.jsonl')
  expect(facts).not.toContain('---')
})

test('without an archive, "+N more" points at the transcript', () => {
  const opts = { ...OPTS, archivePath: undefined }
  const uses = Array.from({ length: 22 }, (_, i) => call('Agent', { description: `job ${i}` }, { agentId: `id${i}` }, `a${i}`))
  const facts = buildFacts([asst(...uses)], opts)
  expect(section(facts, 'Agents spawned')[0]).toBe('+2 more: search the original transcript')
  expect(section(facts, 'Where to look')).toEqual(['- Original transcript: /p/abcd1234.jsonl'])
})

test('empty conversation: no empty sections, still where to look', () => {
  const facts = buildFacts([], OPTS)
  expect(facts).not.toContain("## The user's last")
  expect(facts).not.toContain('## Files touched')
  expect(facts).toContain('## Where to look')
  expect(facts).toEndWith('- Original transcript: /p/abcd1234.jsonl')
})

// ---------------------------------------------------------------- budget, determinism

const BIG: SessionMessage[] = (() => {
  const out: SessionMessage[] = []
  for (let i = 0; i < 120; i++) {
    out.push(user(`request ${i}: ${'r'.repeat(i % 7 === 0 ? 4500 : 600)}`))
    out.push(
      asst(
        call('Read', { file_path: `/big/file${i}.ts` }, {}, `r${i}`),
        call('Bash', { command: `run ${i} https://x.example/${i}` }, { ...(i % 2 === 0 ? { isError: true as const } : {}), text: `Exit code 1\nerror ${i}` }, `b${i}`),
        call('Agent', { description: `agent ${i}` }, { agentId: `ag${i}` }, `a${i}`),
      ),
    )
  }
  return out
})()

test('the budget is never exceeded', () => {
  for (const budget of [200, 700, 1500, 3000, 6000, 12000, 20000, 40000]) {
    const facts = buildFacts(BIG, { ...OPTS, factsBudgetChars: budget })
    expect(facts.length).toBeLessThanOrEqual(budget)
  }
})

test('under budget pressure where to look survives and the verbatim messages go last', () => {
  const instruction = '- Original transcript: /p/abcd1234.jsonl'
  const tight = buildFacts(BIG, { ...OPTS, factsBudgetChars: 6000 })
  expect(tight).toEndWith(instruction)
  expect(tight).toContain("## The user's last messages, verbatim")
  expect(tight).toContain('request 119: ')
  const roomy = buildFacts(BIG, OPTS)
  expect(roomy.length).toBeLessThanOrEqual(20000)
  expect(roomy).toContain('## Earlier messages')
  expect(roomy).toEndWith(instruction)
})

test('deterministic: the same input gives the same output', () => {
  expect(buildFacts(BIG, OPTS)).toBe(buildFacts(BIG, OPTS))
  expect(buildFacts(BIG, { ...OPTS, factsBudgetChars: 5000 })).toBe(buildFacts(BIG, { ...OPTS, factsBudgetChars: 5000 }))
})

test('a 350k-token-sized conversation (~1.4M chars) is processed well inside the 10 s hook budget', () => {
  const msgs: SessionMessage[] = []
  for (let i = 0; i < 1200; i++) {
    msgs.push(user(`ask ${i} ${'p'.repeat(200)}`))
    msgs.push({
      role: 'assistant',
      text: 't'.repeat(150),
      toolUses: [call('Bash', { command: `cmd ${i} https://h.example/${i}` }, { isError: i % 9 === 0 || undefined, text: 'o'.repeat(900) } as Partial<ToolUseSummary>, `b${i}`)],
    })
  }
  const t0 = Date.now()
  const facts = buildFacts(msgs, OPTS)
  const archive = buildArchive(msgs)
  const ms = Date.now() - t0
  expect(archive.length).toBeGreaterThan(1_200_000)
  expect(facts.length).toBeLessThanOrEqual(20000)
  expect(ms).toBeLessThan(2000)
})

// ---------------------------------------------------------------- regressions found in live use

test('a previous reset\'s facts message is never read as the person\'s words', () => {
  const earlier = buildFacts([user('first request')], OPTS)
  expect(personText(earlier)).toBeUndefined()
  const facts = buildFacts([user('first request'), user(earlier), user('second request')], OPTS)
  expect(section(facts, "The user's last messages, verbatim (oldest first)")).toEqual(['### #1', 'first request', '### #3', 'second request'])
  expect(facts.split('# Handoff facts').length).toBe(2) // the header once: no nesting
})

test('a bare /compact and an interrupt marker take no verbatim slot', () => {
  expect(personText('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>')).toBeUndefined()
  expect(personText('[Request interrupted by user]')).toBeUndefined()
  expect(personText('[Request interrupted by user for tool use]')).toBeUndefined()
  const facts = buildFacts(
    [user('the real ask'), user('<command-name>/compact</command-name><command-args></command-args>'), user('[Request interrupted by user]')],
    { ...OPTS, verbatimUserMessages: 1 },
  )
  expect(section(facts, "The user's last messages, verbatim (oldest first)")).toEqual(['### #1', 'the real ask'])
})

test('earlier resets of this session are listed under where to look, oldest first', () => {
  const facts = buildFacts([user('hi')], { ...OPTS, earlierResets: ['/h/session-handoff_2026-11-23_abcd1234-1.md', '/h/session-handoff_2026-11-23_abcd1234-2.md'] })
  expect(section(facts, 'Where to look')).toEqual([
    '- Archive: /h/archive/2026-11-23_abcd1234-1.txt (one line per message: `#n role tool | text`)',
    '- Original transcript: /p/abcd1234.jsonl',
    '- Earlier resets of this session (summary and facts each), in /h/: session-handoff_2026-11-23_abcd1234-1.md, session-handoff_2026-11-23_abcd1234-2.md',
  ])
})

test('earlier resets in different folders are named in full', () => {
  const facts = buildFacts([user('hi')], { ...OPTS, earlierResets: ['/a/session-handoff_x-1.md', '/b/session-handoff_x-2.md'] })
  expect(section(facts, 'Where to look')).toContain('- Earlier resets of this session (summary and facts each): /a/session-handoff_x-1.md, /b/session-handoff_x-2.md')
})

test('an earlier shrink handoff is never read as the person\'s words', () => {
  expect(personText(`${HANDOFF_HEADER}\n## State of work\nx`)).toBeUndefined()
})

// ---------------------------------------------------------------- 0.2.9: facts fixes (design 3.5)

test('firstErrorLine: a non-zero exit with no error-looking line shows the exit code and the last line (0.2.9)', () => {
  // regression: a grep match line was shown as the "error", so the row looked like a success
  expect(firstErrorLine(`Exit code 2\n6:export const V = '1'\n3: "version"`)).toBe('Exit code 2; last line: 3: "version"')
  expect(firstErrorLine('Exit code 1')).toBe('Exit code 1; no output')
  expect(firstErrorLine('Exit code 1\nnpm ERR! missing script')).toBe('npm ERR! missing script')
  expect(firstErrorLine('File does not exist.')).toBe('File does not exist.')
})

test('answersOf reads each answer by its question, quotes inside included (0.2.9)', () => {
  const input = { questions: [{ question: 'Which "folder"?' }, { question: 'Which threshold?' }] }
  const text = 'Your questions have been answered: "Which "folder"?"="Separate new project", "Which threshold?"="200k (Recommended)". You can now continue with these answers in mind.'
  expect(answersOf(input, text)).toEqual([
    { question: 'Which "folder"?', answer: 'Separate new project' },
    { question: 'Which threshold?', answer: '200k (Recommended)' },
  ])
  expect(answersOf(input, 'User declined to answer')).toEqual([])
  expect(answersOf({}, text)).toEqual([])
})

test('AskUserQuestion answers count as the user\'s words, at the line of the result (0.2.9)', () => {
  const ask = call('AskUserQuestion', { questions: [{ question: 'Where should the new mod go?' }] }, {}, 'q1')
  const facts = buildFacts(
    [
      user('build it'),
      asst(ask),
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'q1', isError: false, text: 'Your questions have been answered: "Where should the new mod go?"="Separate new project". You can now continue with these answers in mind.' }],
      },
    ],
    OPTS,
  )
  expect(section(facts, "The user's last messages")).toEqual(['### #1', 'build it', '### #3', '[answer to "Where should the new mod go?"] Separate new project'])
})

test('shellWrites: files a command changes through sed -i, redirection and tee (0.2.9)', () => {
  expect(shellWrites(`sed -i 's/a/b/' src/x.ts && echo hi > out/log.txt 2>/dev/null; cat a | tee -a notes.md`)).toEqual([
    'src/x.ts',
    'out/log.txt',
    'notes.md',
  ])
  expect(shellWrites('cd /p/app && sed -i -e s/a/b/ -e s/c/d/ a.ts b.ts >> /p/log 2>&1')).toEqual(['/p/app/a.ts', '/p/app/b.ts', '/p/log'])
  expect(shellWrites('echo "a > b" > "$OUT" >&2; ls > /dev/null; grep x f | sort')).toEqual([])
  expect(shellWrites("cat > /p/eval.py <<'EOF'\nif a > b: print(1) >> c\nEOF\necho done >> ~/log.md")).toEqual(['/p/eval.py', '~/log.md'])
  expect(shellWrites('python3 - <<EOF\nopen("x","w")\nEOF')).toEqual([])
})

test('files touched: a file changed by a shell command counts as S (0.2.9)', () => {
  const facts = buildFacts(
    [asst(call('Read', { file_path: '/p/a.ts' }, {}, 'r1'), call('Bash', { command: `sed -i 's/x/y/' /p/a.ts` }, { text: '' }, 'b1'))],
    OPTS,
  )
  expect(facts).toContain('## Files touched (R read, W written, E edited, S changed by a shell command; counts)')
  expect(section(facts, 'Files touched')).toEqual(['- /p/a.ts  R1 S1'])
})

// ---------------------------------------------------------------- 0.2.9: commands that worked, names in play (ideas 3, 4)

const ok = (command: string, id: string) => call('Bash', { command }, { text: 'done' }, id)
const okTimes = (command: string, times: number, tag: string) => Array.from({ length: times }, (_, j) => ok(command, `${tag}${j}`))
const say = (text: string, ...toolUses: ToolUseSummary[]): SessionMessage => ({ role: 'assistant', text, toolUses })

test('commandKey: the first three words after cd, env and timing prefixes (0.2.9)', () => {
  expect(commandKey('cd x && claude plugin test a')).toBe('claude plugin test')
  expect(commandKey('cd /p && FOO=1 && timeout 60 env A=b bun test --watch')).toBe('bun test --watch')
  expect(commandKey('time npx tsc -p a')).toBe('npx tsc -p')
})

test('recipeForm: cut at the first top-level pipe or ; after the command, quotes and $( ) kept (0.2.9)', () => {
  expect(recipeForm('cd ~/a && claude plugin test . 2>&1 | grep -B5 x | head -60')).toBe('cd ~/a && claude plugin test .')
  expect(recipeForm('cd ~/a; claude plugin validate . 2>&1 | grep -i warn; sed -n 1,5p README.md')).toBe('cd ~/a; claude plugin validate .')
  expect(recipeForm('npx tsc -p . && claude plugin test . || true')).toBe('npx tsc -p . && claude plugin test .')
  expect(recipeForm('python3 x.py "a|b" \'c;d\' | head')).toBe('python3 x.py "a|b" \'c;d\'')
  expect(recipeForm('X=$(bun a.ts | head -1) && bun b.ts "$X"')).toBe('X=$(bun a.ts | head -1) && bun b.ts "$X"')
  expect(recipeForm('bun test 2>&1')).toBe('bun test 2>&1')
})

test('commands: inline scripts are not recipes, whatever the interpreter path (0.2.9)', () => {
  const facts = buildFacts(
    [user('go'), asst(...okTimes('.venv/bin/python -c "import x"', 2, 'p'), ...okTimes('/usr/bin/node -e "1"', 2, 'n'), ...okTimes('.venv/bin/python build.py 7', 2, 'r'))],
    OPTS,
  )
  expect(section(facts, 'Commands that worked')).toEqual(['- `.venv/bin/python build.py 7` (ok 2x)'])
})

test('commands: the listed form is the command without its one-off filters (0.2.9)', () => {
  const facts = buildFacts(
    [user('go'), asst(ok('cd x && claude plugin test a 2>&1 | grep fail | head', 'a1'), ok('claude plugin test a | tail -3', 'a2'))],
    OPTS,
  )
  expect(section(facts, 'Commands that worked')).toEqual(['- `claude plugin test a` (ok 2x)'])
})

test('commands: single-line Bash that ran ok twice or more, most-run first, latest form (0.2.9)', () => {
  const facts = buildFacts(
    [
      user('go'),
      asst(
        ok('claude plugin test a', 'a1'),
        ok('npx tsc -p a', 't1'),
        ok('claude plugin test a', 'a2'),
        ...okTimes('ls -la', 5, 'l'),
        ...okTimes("cat > /p/x.py <<'EOF'\nprint(1)\nEOF", 2, 'h'),
        ...Array.from({ length: 3 }, (_, j) => call('Bash', { command: 'make build' }, { isError: true, text: 'Exit code 1\nboom' }, `m${j}`)),
        ...Array.from({ length: 2 }, (_, j) => call('Bash', { command: 'make lint' }, { text: 'Exit code 2\nwarn' }, `k${j}`)),
        ok('npx tsc -p a', 't2'),
        ok('cd x && claude plugin test a', 'a3'),
        ok('git commit -m x', 'g1'),
      ),
    ],
    OPTS,
  )
  expect(facts).toContain('## Commands that worked (ran ok; check before re-running)')
  expect(section(facts, 'Commands that worked')).toEqual(['- `cd x && claude plugin test a` (ok 3x)', '- `npx tsc -p a` (ok 2x)'])
})

test('commands: carried from the previous handoff and merged (0.2.9)', () => {
  const previous = [
    HANDOFF_HEADER,
    '## State of work',
    'x',
    '',
    HEADER,
    '',
    '## Commands that worked (ran ok; check before re-running)',
    '- `bun run build` (ok 4x)',
    '- `npx tsc -p a` (ok 2x)',
    '',
    '## Where to look',
    '- Archive: /a',
  ].join('\n')
  const facts = buildFacts([user(`<system-reminder>r</system-reminder>\n${previous}`), asst(ok('npx tsc -p b', 't1'))], OPTS)
  expect(section(facts, 'Commands that worked')).toEqual(['- `bun run build` (ok 4x)', '- `npx tsc -p b` (ok 3x)'])
})

test('commands: side effects, secrets and backticks are never listed (0.2.9)', () => {
  const risky = [
    'rm -rf build',
    'cd /p && git push origin main',
    'gh release create v1',
    'npm publish',
    'TOKEN=abcdefghijklmnopqrstuvwxyz1 bun run deploy',
    'curl -H "Authorization: Bearer abc" https://x.example/api',
    'curl -s -X POST https://x.example/api',
    'bun x `cat f`',
    'git status',
  ]
  const facts = buildFacts([user('go'), asst(...risky.flatMap((c, j) => okTimes(c, 2, `r${j}_`)))], OPTS)
  expect(facts).not.toContain('Commands that worked')
})

test('commands: the home folder is shown as ~ (0.2.9)', () => {
  const facts = buildFacts([user('go'), asst(...okTimes('cd /home/u/app && bun test', 2, 'b'))], { ...OPTS, home: '/home/u' })
  expect(section(facts, 'Commands that worked')).toEqual(['- `cd ~/app && bun test` (ok 2x)'])
})

test('names: identifiers the assistant wrote, most-used first, not already in the state or facts (0.2.9)', () => {
  const facts = buildFacts(
    [
      user('please fix userOnlyName'),
      say('I will change buildFacts; the the the the'),
      say('buildFacts and checkDraft', call('Edit', { file_path: '/p/myModule.ts', old_string: 'myModule()', new_string: 'buildFacts()' }, {}, 'e1')),
      say('buildFacts again, then stateBody and commit c0ffee12'),
      say('', call('Bash', { command: 'python3 -c "print(__file__, \\"\\\\nSHEET\\")"' }, {}, 'b9')),
    ],
    { ...OPTS, stateText: '## Goal\nfix stateBody' },
  )
  expect(section(facts, 'Names in play')).toEqual(['`buildFacts`, `checkDraft`'])
})

test('budget: names drop first and leave no "more" line (0.2.9)', () => {
  const msgs = [
    ...Array.from({ length: 6 }, (_, i) => user(`message number ${i}`)),
    say('alphaOne betaTwo gammaThree deltaFour epsilonFive'),
  ]
  const opts = { ...OPTS, verbatimUserMessages: 2 }
  const full = buildFacts(msgs, opts)
  const cut = buildFacts(msgs, { ...opts, factsBudgetChars: full.length - 20 })
  expect(cut.length).toBeLessThanOrEqual(full.length - 20)
  expect(section(cut, 'Earlier messages')).toEqual(section(full, 'Earlier messages'))
  const names = section(cut, 'Names in play')
  expect(names).toHaveLength(1)
  expect(names[0]!.split(', ').length).toBeLessThan(5)
  const none = buildFacts(msgs, { ...opts, factsBudgetChars: full.length - section(full, 'Names in play')[0]!.length - 20 })
  expect(none).not.toContain('Names in play')
  expect(section(none, 'Earlier messages')).toEqual(section(full, 'Earlier messages'))
})

test('earlier resets: Windows paths are grouped by their folder too (0.2.9)', () => {
  const facts = buildFacts([user('go')], { ...OPTS, earlierResets: ['C:\\h\\session-handoff_x-1.md', 'C:\\h\\session-handoff_x-2.md'] })
  expect(section(facts, 'Where to look')).toContain('- Earlier resets of this session (summary and facts each), in C:\\h\\: session-handoff_x-1.md, session-handoff_x-2.md')
})

// ---------------------------------------------------------------- 0.2.10: failed or blocked calls

const GUARD = 'PreToolUse:Write hook error: [guard]: Write outside the research folder'

test('files touched: a failed Write, Edit or Read is not a file touched (0.2.10)', () => {
  // regression: a write blocked by a guard hook was listed as W1
  const facts = buildFacts(
    [
      asst(
        call('Write', { file_path: '/m/memory/note.md', content: 'x' }, { isError: true, text: GUARD }, 'w1'),
        call('Edit', { file_path: '/p/b.ts', old_string: 'a', new_string: 'b' }, { isError: true, text: 'String to replace not found in file.' }, 'e1'),
        call('Read', { file_path: '/p/missing' }, { isError: true, text: 'File does not exist.' }, 'r1'),
        call('Read', { file_path: '/p/a.ts' }, { text: 'body' }, 'r2'),
      ),
    ],
    OPTS,
  )
  expect(section(facts, 'Files touched')).toEqual(['- /p/a.ts  R1'])
  expect(section(facts, 'Failed commands and errors')).toEqual([
    `- #1 Write: /m/memory/note.md → ${GUARD}`,
    '- #1 Edit: /p/b.ts → String to replace not found in file.',
    '- #1 Read: /p/missing → File does not exist.',
  ])
})

test('files touched: a shell write a hook blocked is not a file touched; one that ran and then failed still is (0.2.10)', () => {
  // regression: `cat > …/gen.py` blocked by a guard hook was listed as S1
  const facts = buildFacts(
    [
      asst(
        call('Bash', { command: 'cat > /tmp/x/gen.py <<EOF\nprint(1)\nEOF' }, { isError: true, text: 'PreToolUse:Bash hook error: [guard]: redirect outside the research folder' }, 'b1'),
        call('Bash', { command: "sed -i 's/a/b/' /p/c.py && python3 /p/c.py" }, { isError: true, text: 'Exit code 1\nValueError: tab' }, 'b2'),
      ),
    ],
    OPTS,
  )
  expect(section(facts, 'Files touched')).toEqual(['- /p/c.py  S1'])
})

test('firstErrorLine: a shell error beats file content that mentions errors (0.2.10)', () => {
  // regression: a notes file printed by `cat` was shown instead of the `ls` error
  const out = [
    'Exit code 2',
    '- Check: review the notes before the next run',
    'build.log',
    "ls: cannot access '/h/tools/build.py': No such file or directory",
    '/h2/tools/build.py',
  ].join('\n')
  expect(firstErrorLine(out)).toBe("ls: cannot access '/h/tools/build.py': No such file or directory")
  expect(firstErrorLine('Exit code 127\nnotes about a failed run\nbash: foo: command not found')).toBe('bash: foo: command not found')
  // one error line is still found as before
  expect(firstErrorLine('Exit code 1\nnpm ERR! missing script')).toBe('npm ERR! missing script')
  expect(firstErrorLine('Exit code 1\n\ncollected 3\nE   AssertionError: 2 != 3\nFAILED t.py')).toBe('E   AssertionError: 2 != 3')
})

// regression: `…; diff before after && echo SAME` exited 1 because the files differed
const DIFFED = "Exit code 1\n5:(2) ranks\nEXIT=0\n2c2\n< 'q one' | 14 | 14\n---\n> 'q one' | 14 | 9"
const DIFF_CMD = 'cd /p && grep -n "rank\\|RANK" a.py | head -12; S=/s; python3 run.py > $S/after.txt 2>&1; echo EXIT=$?; diff $S/before.txt $S/after.txt && echo SAME'

test('noMatchExit: exit 1 from a last grep, rg, diff or cmp with other output and no error line (0.2.10)', () => {
  expect(noMatchExit(DIFF_CMD, DIFFED)).toBe(true)
  expect(noMatchExit('make build; grep -n foo out.log', 'Exit code 1\nbuilt 3 targets')).toBe(true)
  expect(noMatchExit('ls /p | rg x', 'Exit code 1\na')).toBe(true)
  // the whole command was the grep, and it found nothing: still a failure
  expect(noMatchExit('grep -n foo a.py', 'Exit code 1')).toBe(false)
  // an error line means something else failed
  expect(noMatchExit('cat a; grep x b', 'Exit code 1\ngrep: b: No such file or directory')).toBe(false)
  // exit 2 is grep's own error; a last command that is not a match tool is a failure
  expect(noMatchExit('cat a; grep x b', 'Exit code 2\nhello')).toBe(false)
  expect(noMatchExit('grep x a; python3 t.py', 'Exit code 1\nhello')).toBe(false)
  // a `|` inside the grep pattern's quotes does not end it
  expect(noMatchExit('cat a; grep -n "x\\|y | z" b', 'Exit code 1\nhello')).toBe(true)
})

test('failed commands: a compound command whose only failure is a last diff or grep with no match is not failed (0.2.10)', () => {
  const facts = buildFacts(
    [
      asst(
        call('Bash', { command: DIFF_CMD }, { isError: true, text: DIFFED }, 'b1'),
        call('Bash', { command: 'grep -n foo a.py' }, { isError: true, text: 'Exit code 1' }, 'b2'),
      ),
    ],
    OPTS,
  )
  expect(section(facts, 'Failed commands and errors')).toEqual(['- #1 Bash: grep -n foo a.py → Exit code 1; no output'])
})
