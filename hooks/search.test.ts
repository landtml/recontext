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
