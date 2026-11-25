import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { buildArchive } from './archive'
import { buildFacts, personText, type FactsOptions } from './facts'
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
    '- #2 Bash: make → make: *** No rule to make target',
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
  expect(section(facts, 'Failed commands and errors')).toEqual(['- #1 Bash: false → Exit code 1'])
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
