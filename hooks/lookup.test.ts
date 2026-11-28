import { expect, test } from 'claude-code/testing'
import type { IndexEntry, SessionIndex } from './index'
import { emptyIndex } from './index'
import { withLines, archiveLines, findEntries, formatLookup, isLocator, lookup, lookupAnswers, lookupTerms, matchTerm, refParts, wantsModel } from './lookup'

const entry = (item: string, kind: IndexEntry['kind'], refs: string[], more: Partial<IndexEntry> = {}): IndexEntry =>
  ({ item, kind, typed: 1, shown: 0, win: 0, marks: '', lastSeg: 1, lastPos: 10, refs, ...more })
const indexOf = (...es: IndexEntry[]): SessionIndex => {
  const idx = emptyIndex()
  for (const e of es) idx.entries.set(e.item, e)
  return idx
}

const IDX = indexOf(
  entry('~/proj/hooks/facts.ts', 'path', ['1:4', '2:9'], { marks: 'RE', lastSeg: 2, lastPos: 50 }),
  entry('~/proj/tools/facts.ts', 'path', ['1:7'], { lastPos: 20 }),
  entry('mergeIndex', 'camel', ['2:3']),
  entry('0.2.12', 'ver', ['1:2']),
  entry('npm test', 'command', ['2:5'], { result: '334 pass' }),
  entry('deadbeef-3#12', 'hex', ['deadbeef-3#12']),
)
const ARCHIVE_1 = ['#2 user | install 0.2.12 now', '#4 assistant Read | read ~/proj/hooks/facts.ts', '#7 assistant | tools copy'].join('\n')
const ARCHIVE_2 = ['#3 assistant | mergeIndex merges', '#5 assistant Bash | npm test → 334 pass', '#9 assistant Edit | edited ~/proj/hooks/facts.ts'].join('\n')
const read = (p: { sid8: string; k: number }) => (p.sid8 !== 'aaaaaaaa' ? undefined : p.k === 1 ? ARCHIVE_1 : p.k === 2 ? ARCHIVE_2 : undefined)

test('terms come from leads, backticks and the question\'s items, home folded, each once', () => {
  expect(lookupTerms('what did `npm test` print for mergeIndex in /home/u/proj/a.ts?', ['mergeIndex', '  0.2.12 '], '/home/u')).toEqual([
    'mergeIndex', '0.2.12', 'npm test', '~/proj/a.ts',
  ])
  expect(lookupTerms('where?', ['ab'])).toEqual([])
})

test('match order: exact, then file name (newest first), then substring of 4+', () => {
  const es = [...IDX.entries.values()]
  expect(matchTerm('mergeIndex', es, IDX.entries)?.how).toBe('exact')
  const f = matchTerm('facts.ts', es, IDX.entries)!
  expect(f.how).toBe('file')
  expect(f.entries.map(e => e.item)).toEqual(['~/proj/hooks/facts.ts', '~/proj/tools/facts.ts'])
  expect(matchTerm('mergeind', es, IDX.entries)?.entries[0]!.item).toBe('mergeIndex')
  expect(matchTerm('npm', es, IDX.entries)).toBeUndefined()
  expect(matchTerm('nothing-here', es, IDX.entries)).toBeUndefined()
})

test('each entry is hit once and unmatched terms are kept', () => {
  const r = findEntries(['~/proj/hooks/facts.ts', 'facts.ts', 'zzzz'], IDX)
  expect(r.hits.map(h => [h.how, h.entry.item])).toEqual([
    ['exact', '~/proj/hooks/facts.ts'],
    ['file', '~/proj/tools/facts.ts'],
  ])
  expect(r.unmatched).toEqual(['zzzz'])
})

test('refs: plain is this session, qualified names its own session', () => {
  expect(refParts('2:9', 'aaaaaaaa')).toEqual({ sid8: 'aaaaaaaa', k: 2, n: 9, label: '#2:9' })
  expect(refParts('deadbeef-3#12', 'aaaaaaaa')).toEqual({ sid8: 'deadbeef', k: 3, n: 12, label: 'deadbeef-3#12' })
  expect(refParts('junk', 'aaaaaaaa')).toBeUndefined()
})

test('archive lines: the message\'s line naming the item, cut long lines around the item', () => {
  expect(archiveLines(ARCHIVE_2, 9, '~/proj/hooks/facts.ts')).toEqual(['#9 assistant Edit | edited ~/proj/hooks/facts.ts'])
  expect(archiveLines(ARCHIVE_2, 4, 'x')).toEqual([])
  const long = `#1 assistant | ${'x'.repeat(600)} theItem tail`
  const [cut] = archiveLines(long, 1, 'theItem')
  expect(cut!.includes('theItem')).toBe(true)
  expect(cut!.length <= 300).toBe(true)
})

test('lookup reads the last refs from the archives, and says when one is missing', () => {
  const l = lookup('where is facts.ts?', [], IDX, 'aaaaaaaa', read)
  expect(l.hits[0]!.lines).toEqual([
    { ref: '#1:4', text: '#4 assistant Read | read ~/proj/hooks/facts.ts' },
    { ref: '#2:9', text: '#9 assistant Edit | edited ~/proj/hooks/facts.ts' },
  ])
  const q = lookup('?', ['deadbeef-3#12'], IDX, 'aaaaaaaa', read)
  expect(q.hits[0]!.lines).toEqual([{ ref: 'deadbeef-3#12', text: '(archive not found)' }])
})

test('code answers alone only a where/which/when question whose terms all matched', () => {
  const l = lookup('where did we edit facts.ts?', ['facts.ts'], IDX, 'aaaaaaaa', read)
  expect(lookupAnswers(l, 'where did we edit facts.ts?')).toBe(true)
  expect(lookupAnswers(l, 'which shrink last touched facts.ts?')).toBe(true)
  expect(wantsModel('why did npm test fail?')).toBe(true)
  expect(isLocator('when was 0.2.12 first mentioned?')).toBe(true)
  expect(lookupAnswers(l, 'what error did facts.ts give?')).toBe(false)
  expect(lookupAnswers(l, 'where did the facts.ts change break?')).toBe(false)
  expect(lookupAnswers(l, 'tell me about facts.ts')).toBe(false)
  const half = lookup('where are these?', ['npm test', 'zzzz'], IDX, 'aaaaaaaa', read)
  expect(lookupAnswers(half, 'where are these?')).toBe(false)
  const none = lookup('where is qqqq?', ['qqqq'], IDX, 'aaaaaaaa', read)
  expect(lookupAnswers(none, 'where is qqqq?')).toBe(false)
})

test('the reply names kind, counts, marks, result and the archive lines, and stays under the cap', () => {
  const l = lookup('what about facts.ts and npm test?', ['npm test'], IDX, 'aaaaaaaa', read)
  const text = formatLookup(l, true)
  expect(text.startsWith('Exact lookup in the session index (by code, no model call')).toBe(true)
  expect(text.includes('- `npm test` (command, typed 1, last shrink 1; first #2:5, 1 refs kept)\n  result: 334 pass')).toBe(true)
  expect(text.includes('RE, last shrink 2, file match for "facts.ts"')).toBe(true)
  expect(text.includes('  #2:5: #5 assistant Bash | npm test → 334 pass')).toBe(true)
  expect(formatLookup(l, true, 120).length <= 120).toBe(true)
  expect(formatLookup(l, false).includes('ask again with why')).toBe(false)
})

test('precision: lib.py names lib.py files, not every *lib.py*; substring only when nothing else matched', () => {
  const idx = indexOf(
    entry('src/lib.py', 'path', ['1:1']),
    entry('src/mylib.py', 'path', ['1:2']),
    entry('tools/stdlib.pyc', 'path', ['1:3']),
  )
  const es = [...idx.entries.values()]
  const m = matchTerm('lib.py', es, idx.entries)!
  expect([m.how, m.entries.map(e => e.item)]).toEqual(['file', ['src/lib.py']])
  const bare = indexOf(entry('lib.py', 'file', ['1:1']), entry('src/lib.py', 'path', ['1:2']))
  expect(matchTerm('lib.py', [...bare.entries.values()], bare.entries)!.entries.map(e => e.item)).toEqual(['lib.py'])
  const only = indexOf(entry('src/mylib.py', 'path', ['1:2']))
  expect(matchTerm('lib.py', [...only.entries.values()], only.entries)?.how).toBe('substring')
})

test('a full path finds a shorter indexed path it ends with; a bare name finds its file by stem', () => {
  const idx = indexOf(
    entry('logs/debug.log', 'path', ['6:1']),
    entry('tools/run_batches.py', 'path', ['25:4']),
    entry('run_batches.py', 'file', ['25:2']),
    entry('tools/run_batchesx.py', 'path', ['25:5']),
  )
  const es = [...idx.entries.values()]
  const s = matchTerm('~/Documents/proj/logs/debug.log', es, idx.entries)!
  expect([s.how, s.entries.map(e => e.item)]).toEqual(['suffix', ['logs/debug.log']])
  expect(matchTerm('~/Documents/proj/xlogs/debug.log', es, idx.entries)?.how).not.toBe('suffix')
  const st = matchTerm('run_batches', es, idx.entries)!
  expect([st.how, st.entries.map(e => e.item)]).toEqual(['stem', ['tools/run_batches.py', 'run_batches.py']])
  expect(matchTerm('batches', es, idx.entries)?.how).toBe('substring')
})

test('archive lines match the item with the home folder written as ~', () => {
  const arch = `#2 tool Bash ok | ${'y'.repeat(400)} /home/u/proj/a.ts here`
  const [line] = archiveLines(arch, 2, '~/proj/a.ts', 1, '/home/u')
  expect(line!.includes('~/proj/a.ts')).toBe(true)
})

test('lines: refs whose line shows the item come first; a cut one says where its text is', () => {
  const entry = { item: 'needle', kind: 'name', typed: 1, shown: 1, lastSeg: 1, refs: ['1:1', '1:2', '1:3', '1:4'] } as any
  const arch = [
    '#1 assistant | the needle here',
    '#2 tool Bash ok | lots… (full: transcript, tool_use_id toolu_A)',
    '#3 assistant | {"file_path":"f","content":"abc…[+900]"}',
    '#4 tool Read ok | other… (full: transcript, tool_use_id toolu_B)',
  ].join('\n')
  const one = withLines({ term: 'needle', how: 'exact', entry }, 'aaaaaaaa', () => arch)
  expect(one.lines.map(l => l.ref)).toEqual(['#1:1', '#1:3', '#1:4'])
  expect(one.lines[0]!.text).toBe('#1 assistant | the needle here')
  expect(one.lines[2]!.text.endsWith('[item in the cut part; full text: transcript, tool_use_id toolu_B]')).toBe(true)
  expect(one.lines[1]!.text.endsWith('[item in the cut part of the written content; full text: transcript]')).toBe(true)
})
