import { expect, test } from 'claude-code/testing'
import { golden } from '../fixtures/golden'
import { messages as sample } from '../fixtures/sample-session'
import { expand, search, tokenize, unitTokens } from './search'
import { buildUnits, type Unit } from './units'

const unit = (n: number, text: string, extra: Partial<Unit> = {}): Unit => ({
  ref: `s1-1#${n}`,
  session: 's1',
  k: 1,
  n,
  kind: 'assistant',
  text,
  entities: [],
  ...extra,
})

test('tokenize keeps a path whole and also yields its parts', () => {
  const t = tokenize('Edit /p/parser.py now.')
  expect(t).toContain('/p/parser.py')
  expect(t).toContain('parser')
  expect(t).toContain('py')
  expect(t).toContain('edit')
})

test('tokenize splits snake_case and camelCase and drops stopwords', () => {
  const t = tokenize('What is test_calc and buildUnits?')
  expect(t).toContain('test_calc')
  expect(t).toContain('test')
  expect(t).toContain('calc')
  expect(t).toContain('build')
  expect(t).toContain('unit')
  expect(t.filter(x => x === 'buildunit')).toHaveLength(1)
  expect(t).not.toContain('what')
  expect(t).not.toContain('is')
})

test('tokenize folds plural and -ing/-ed forms onto one stem; paths stay whole', () => {
  const t = tokenize('emails uploading sending added /p/files.py')
  expect(t).toContain('email')
  expect(t).toContain('upload')
  expect(t).toContain('send')
  expect(t).toContain('add')
  expect(t).toContain('/p/files.py')
  expect(tokenize('email upload send add')).toEqual(['email', 'upload', 'send', 'add'])
})

// Known miss: search matches whole words, so "PDF" does not find the answer, which names only fpdf2 and pypdf.
const KNOWN_MISSES = ['Which PDF libraries are installed in the environment?']

test('golden set: every answerable question but the known misses has its answer in the top 8 hits', () => {
  const units = buildUnits(sample, { session: 'c0ffee12', k: 1 })
  const missed = golden
    .filter(g => g.refs.length > 0)
    .filter(g => !search(units, g).some(h => g.refs.includes(h.unit.ref)))
    .map(g => g.question)
  expect(missed).toEqual(KNOWN_MISSES)
})

test('a rare word ranks the unit holding it first', () => {
  const units = [unit(1, 'we ran the tests'), unit(2, 'the protego module was missing'), unit(3, 'the tests ran again')]
  expect(search(units, { question: 'why was protego missing?' })[0]!.unit.n).toBe(2)
})

test('a lead beats a plain word match', () => {
  const units = [
    unit(1, 'calc tests failed with an assertion', { kind: 'tool' }),
    unit(2, 'Write: test_calc.py created', { kind: 'tool', entities: ['test_calc.py'] }),
  ]
  expect(search(units, { question: 'what failed in the calc tests?', leads: ['test_calc.py'] })[0]!.unit.n).toBe(2)
})

test('an exact quoted phrase wins', () => {
  const units = [unit(1, 'the cache was cold and the run was slow'), unit(2, 'we saw "cold start" errors in the run')]
  expect(search(units, { question: 'where did we see "cold start"?' })[0]!.unit.n).toBe(2)
})

test('the current session ranks first on equal evidence', () => {
  const a = unit(1, 'the parser handles tabs', { session: 'old', ref: 'old-1#1' })
  const b = unit(1, 'the parser handles tabs', { session: 'cur', ref: 'cur-1#1' })
  expect(search([a, b], { question: 'parser tabs' }, { currentSession: 'cur' })[0]!.unit.session).toBe('cur')
})

test('a question with nothing in common returns no hits', () => {
  expect(search([unit(1, 'the parser handles tabs')], { question: 'kubernetes helm values?' })).toEqual([])
})

test('expand adds call partners and neighbours within the budget; hits always stay', () => {
  const units = [
    unit(1, 'a'.repeat(50)),
    unit(2, 'the protego module'),
    unit(2, 'Bash: pip list', { ref: 's1-1#2.1', kind: 'tool' }),
    unit(3, 'c'.repeat(50)),
    unit(9, 'z'.repeat(5000)),
  ]
  const hits = search(units, { question: 'protego' })
  const out = expand(units, hits, 200)
  expect(out.map(u => u.ref)).toEqual(['s1-1#1', 's1-1#2', 's1-1#2.1', 's1-1#3'])
  expect(expand(units, hits, 10).map(u => u.ref)).toEqual(['s1-1#2'])
})

test('golden set: the answering unit is in the evidence for at least 11 of 12', () => {
  const units = buildUnits(sample, { session: 'c0ffee12', k: 1 })
  const answerable = golden.filter(g => g.refs.length > 0)
  const found = answerable.filter(g => {
    const refs = new Set(expand(units, search(units, g), 60000).map(u => u.ref))
    return g.refs.some(r => refs.has(r))
  })
  expect(answerable).toHaveLength(12)
  expect(found.length).toBeGreaterThanOrEqual(11)
})

test('golden set: questions the fixture cannot answer return no hits', () => {
  const units = buildUnits(sample, { session: 'c0ffee12', k: 1 })
  for (const g of golden.filter(x => x.refs.length === 0)) expect(search(units, g)).toEqual([])
})

test('a plain #n in the question goes first to that message of the current session\'s latest archive (0.2.4)', () => {
  // regression: "what happened at #107" came back not-found although line 107 held the answer
  const units = [
    unit(7, 'rm the bundle file', { ref: 's1-1#7' }),
    unit(7, 'rm the bundle file', { ref: 's1-2#7', k: 2 }),
    unit(7, 'Bash: rm bundle/ref.pdf', { ref: 's1-2#7.1', k: 2, kind: 'tool' }),
    unit(7, 'rm the bundle file', { ref: 'old-3#7', session: 'old', k: 3 }),
    unit(9, 'what happened to the bundle file: rm, happened', { ref: 's1-2#9', k: 2 }),
  ]
  const hits = search(units, { question: 'What happened at #7 to the bundle file?' }, { currentSession: 's1' })
  expect(hits.slice(0, 2).map(h => h.unit.ref)).toEqual(['s1-2#7', 's1-2#7.1'])
})

test('a #k:n or a full ref in the leads goes first to that message (0.2.4)', () => {
  const units = [
    unit(7, 'removed the sheet', { ref: 's1-1#7' }),
    unit(7, 'removed the sheet', { ref: 's1-2#7', k: 2 }),
    unit(7, 'removed the sheet', { ref: 'old-3#7', session: 'old', k: 3 }),
    unit(8, 'what was removed: the sheet was removed', { ref: 's1-2#8', k: 2 }),
  ]
  const ask = (leads: string[]) => search(units, { question: 'what was removed?', leads }, { currentSession: 's1' })[0]!.unit.ref
  expect(ask(['#1:7'])).toBe('s1-1#7')
  expect(ask(['old-3#7'])).toBe('old-3#7')
})

test('a plain #n that cites a tool result goes first to the call that has it (0.2.4)', () => {
  const convo = [
    { role: 'user' as const, text: 'run the parser', toolUses: [] },
    { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'python3 p.py' } }] },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: "['a', 'b']", isError: false }] },
    { role: 'assistant' as const, text: 'It printed the list.', toolUses: [] },
  ]
  const units = buildUnits(convo, { session: 's1', k: 2 })
  const hits = search(units, { question: 'What did the Bash command at #3 print?', leads: ['#3'] }, { currentSession: 's1' })
  expect(hits[0]!.unit.ref).toBe('s1-2#2.1')
  // the hit says which ref it answers, once, as the question wrote it
  expect(hits[0]!.named).toEqual(['#3'])
  expect(hits.slice(1).every(h => h.named === undefined)).toBe(true)
})

test('in a shard from before 0.2.4 (no result lines), a ref to a line with no unit goes to the calls just before it', () => {
  const old = [
    unit(2, 'Bash: python3 p.py\n[\'a\', \'b\']', { ref: 's1-1#2.1', kind: 'tool', tool: 'Bash' }),
    unit(4, 'It printed the list.', { ref: 's1-1#4' }),
    unit(6, 'Bash: ls\nmain.py', { ref: 's1-1#6.1', kind: 'tool', tool: 'Bash' }),
  ]
  const ask = (q: string) => search(old, { question: q }, { currentSession: 's1' })[0]?.unit.ref
  expect(ask('What did #3 print?')).toBe('s1-1#2.1')
  // with result lines recorded, a line nothing claims is not guessed
  const fresh = old.map(u => (u.ref === 's1-1#6.1' ? { ...u, resultN: 7 } : u))
  expect(search(fresh, { question: 'What did #3 print?' }, { currentSession: 's1' }).map(h => h.unit.ref)).not.toContain('s1-1#2.1')
})

test('expand: the token ceiling holds even when many hits are named; the first hit always stays', () => {
  const units = Array.from({ length: 30 }, (_, i) => unit(i + 1, `big ${'x'.repeat(4000)}`))
  const hits = units.map(u => ({ unit: u, score: 1, named: [`#${u.n}`] }))
  const out = expand(units, hits, 1_000_000, 10000)
  const tokens = out.reduce((s, u) => s + unitTokens(u), 0)
  expect(tokens).toBeLessThanOrEqual(10000)
  expect(out.length).toBeGreaterThan(1)
  expect(out[0]!.ref).toBe('s1-1#1')
  expect(expand(units, hits.slice(0, 1), 1_000_000, 10).map(u => u.ref)).toEqual(['s1-1#1'])
})

test('a ref to a long result names its first part only; later parts are found by their words (0.2.9)', () => {
  const units = [
    unit(3, 'Bash: gh release --help\nUSAGE gh release', { kind: 'tool', tool: 'Bash', ref: 's1-1#3.1' }),
    unit(3, 'Bash (part 2 of 3): gh release --help\nFLAGS --notes-file', { kind: 'tool', tool: 'Bash', ref: 's1-1#3.1p2', part: 2 }),
    unit(3, 'Bash (part 3 of 3): gh release --help\nFLAGS --verify-tag', { kind: 'tool', tool: 'Bash', ref: 's1-1#3.1p3', part: 3 }),
    unit(5, 'later text'),
  ]
  const hits = search(units, { question: 'what did #3 print?' }, { currentSession: 's1' })
  expect(hits.filter(h => h.named?.length).map(h => h.unit.ref)).toEqual(['s1-1#3.1'])
  expect(search(units, { question: 'which flag is --verify-tag' }, { currentSession: 's1' })[0]!.unit.ref).toBe('s1-1#3.1p3')
})

test('expand: later parts of a long result come in only as hits, never as neighbours (0.2.9)', () => {
  const units = [
    unit(3, 'Bash: cat big\nhead of it', { kind: 'tool', tool: 'Bash', ref: 's1-1#3.1' }),
    unit(3, `Bash (part 2 of 3): cat big\n${'p'.repeat(8000)}`, { kind: 'tool', tool: 'Bash', ref: 's1-1#3.1p2', part: 2 }),
    unit(3, `Bash (part 3 of 3): cat big\n${'q'.repeat(8000)} needle`, { kind: 'tool', tool: 'Bash', ref: 's1-1#3.1p3', part: 3 }),
    unit(4, 'the reply after it'),
  ]
  const fromFirst = expand(units, [{ unit: units[0]!, score: 1 }], 60000)
  expect(fromFirst.map(u => u.ref)).toEqual(['s1-1#3.1', 's1-1#4'])
  const fromPart = expand(units, [{ unit: units[2]!, score: 1 }], 60000)
  expect(fromPart.map(u => u.ref)).toEqual(['s1-1#3.1', 's1-1#3.1p3', 's1-1#4'])
})

test('search: a pinned unit does not take a ranked slot (0.2.10)', () => {
  const units = [unit(1, 'unrelated opening note'), ...Array.from({ length: 10 }, (_, i) => unit(i + 3, `parser crash number ${i}`))]
  const hits = search(units, { question: 'why did the parser crash, see #1' }, { currentSession: 's1' })
  expect(hits).toHaveLength(9)
  expect(hits[0]!.unit.ref).toBe('s1-1#1')
  expect(hits[0]!.named).toEqual(['#1'])
  expect(hits.slice(1).every(h => h.unit.text.startsWith('parser crash'))).toBe(true)
})

test('search: at most 4 pinned units, in the order named (0.2.10)', () => {
  const named = [21, 23, 25, 27, 29, 31].map(n => unit(n, `note ${n}`))
  const ranked = Array.from({ length: 10 }, (_, i) => unit(i + 1, `parser crash number ${i}`))
  const hits = search([...ranked, ...named], { question: 'parser crash at #27 #21 #31 #23 #25 #29', leads: ['parser crash'] }, { currentSession: 's1' })
  expect(hits.slice(0, 4).map(h => h.unit.n)).toEqual([27, 21, 31, 23])
  expect(hits).toHaveLength(12)
  expect(hits.slice(4).every(h => h.named === undefined && h.unit.text.startsWith('parser crash'))).toBe(true)
})

test('search: a text archived twice is shown once, at its best rank (0.2.10)', () => {
  const twice = 'Bash: bun test\n12 pass parser crash fixed'
  const units = [
    unit(4, twice, { ref: 's1-1#4.1', kind: 'tool', tool: 'Bash' }),
    unit(2, twice, { ref: 's1-2#2.1', k: 2, kind: 'tool', tool: 'Bash' }),
    ...Array.from({ length: 8 }, (_, i) => unit(i + 10, `parser crash note ${i}`)),
  ]
  const hits = search(units, { question: 'parser crash fixed?', leads: ['parser crash'] }, { currentSession: 's1' })
  expect(hits.filter(h => h.unit.text === twice)).toHaveLength(1)
  expect(hits).toHaveLength(8)
})

test('expand: hits past the core come after the neighbours, and only if they fit (0.2.10)', () => {
  const units = [unit(1, 'a'.repeat(100)), unit(2, 'b'.repeat(100)), unit(3, 'c'.repeat(100)), unit(9, 'z'.repeat(150))]
  const hits = [units[1]!, units[3]!].map(u => ({ unit: u, score: 1 }))
  // core 1: the neighbours of the first hit fill the budget before the extra hit is tried
  expect(expand(units, hits, 300, Infinity, 1).map(u => u.n)).toEqual([1, 2, 3])
  expect(expand(units, hits, 450, Infinity, 1).map(u => u.n)).toEqual([1, 2, 3, 9])
  // no core given: every hit first, as before
  expect(expand(units, hits, 300, Infinity).map(u => u.n)).toEqual([2, 9])
})

test("a unit ref into another session's archive pins that unit (0.2.11: refs a forked session inherits)", () => {
  const units = [
    unit(1, 'the parser handles tabs'),
    unit(40, 'decided: the gate keeps commas out of numbers', { session: '4a9e7c13', k: 3, ref: '4a9e7c13-3#40' }),
    unit(2, 'the parser handles spaces'),
  ]
  const hits = search(units, { question: 'What was decided at 4a9e7c13-3#40 about the parser?' }, { currentSession: 's1' })
  expect(hits[0]!.unit.ref).toBe('4a9e7c13-3#40')
  expect(hits[0]!.named).toEqual(['4a9e7c13-3#40'])
})
