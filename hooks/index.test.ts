import type { SessionMessage, ToolUseSummary } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { HANDOFF_HEADER } from './prompt'
import {
  COMMANDS_KEPT, REFS_KEPT, emptyIndex, features, itemsOf, mergeIndex, messageKey, parseIndex, rankEntries, RANK_WEIGHTS, seedFromParent, serializeIndex,
} from './index'

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const asst = (text: string, ...toolUses: ToolUseSummary[]): SessionMessage => ({ role: 'assistant', text, toolUses })
let ids = 0
const call = (tool: string, input: Record<string, unknown>, out: Partial<ToolUseSummary> = {}): ToolUseSummary =>
  ({ tool_use_id: `toolu_${++ids}`, tool, input, ...out })

// expected values from tools/check/meter.py items_of on the same strings (the meter that measured 0.3.0)
const PARITY: [string, string[]][] = [
  ["see ~/Documents/proj/hooks/facts.ts and ./tools/x.py.", ["./tools/x.py", "~/Documents/proj/hooks/facts.ts"]],
  ["session 3f1c8a20-7b4e-4d91-9a6c-2e5f0b8d1c47 ended", ["3f1c8a20-7b4e-4d91-9a6c-2e5f0b8d1c47"]],
  ["installed 0.2.12, not 0.2.9 or 1.2", ["0.2.12", "0.2.9"]],
  ["call build_facts and mergeIndex then lastSeg", ["build_facts", "lastSeg", "mergeIndex"]],
  ["run rank_fit.py --fit", ["rank_fit.py"]],
  ["hash 3f9a2c1 and 1920x1080 at 35ms, 123456", ["3f9a2c1"]],
  ["/tmp/claude-1000/x/y.txt and /usr/lib/node", []],
  ["CLAUDE.md MEMORY.md memory/foo-bar.md", []],
  ["a/b c/d/e short/path/here", ["short/path/here"]],
  ["(see src/app/main.rs).", ["src/app/main.rs"]],
  ["file_path: tools/check/meter.py:47", ["file_path", "tools/check/meter.py"]],
  ["mcp__shrink__recall was used", []],
  ["mcp__shrinktest__recall was allowed", ["mcp__shrinktest__recall"]],
  ["npm i @anthropic-ai/sdk@0.30.1", ["@anthropic-ai/sdk@0.30.1"]],
  ["getX fooBarBaz isOk", ["fooBarBaz"]],
  ["per_page a_b TOKEN_CAP x_1", ["TOKEN_CAP", "per_page"]],
  ["deadbeef cafe 0a1b2c3d4e", ["0a1b2c3d4e"]],
  ["../up/one.json and ../../two/three", ["../../two/three", "../up/one.json"]],
  ["url https://example.com/a/b.html", ["b.html"]],
  ["README.md, notes.txt; plan-v2.md", ["README.md", "notes.txt", "plan-v2.md"]],
  ["v1.2.3-beta and 10.20.30", ["10.20.30"]],
]

test('itemsOf matches the Python meter on the fixture strings', () => {
  for (const [s, want] of PARITY) expect(itemsOf(s).map(x => x.item).sort()).toEqual(want)
})

test('itemsOf writes the home folder as ~ and names the kind', () => {
  expect(itemsOf('read /home/u/Documents/p/a.ts', '/home/u')).toEqual([{ item: '~/Documents/p/a.ts', kind: 'path' }])
  expect(itemsOf('0.2.12 3f9a2c1 ab_cdef fooBar x.json').map(x => x.kind)).toEqual(['ver', 'hex', 'snake', 'camel', 'file'])
})

test('merge counts typed and shown apart, and marks paths', () => {
  const w = [
    user('please look at hooks/facts.ts'),
    asst('reading tools/rank_fit.py', call('Read', { file_path: '/home/u/p/tools/rank_fit.py' }, { text: 'def pack_groups(): ...' })),
    asst('', call('Edit', { file_path: '/home/u/p/tools/rank_fit.py', old_string: 'a', new_string: 'b' }, { text: 'ok' })),
  ]
  const idx = mergeIndex(emptyIndex(), w, { k: 1, home: '/home/u' })
  const p = idx.entries.get('~/p/tools/rank_fit.py')!
  expect(p.typed).toBe(2)
  expect(p.marks).toBe('RE')
  expect(idx.entries.get('hooks/facts.ts')!.shown).toBe(1)
  expect(idx.entries.get('hooks/facts.ts')!.typed).toBe(0)
  expect(idx.entries.get('pack_groups')!.shown).toBe(1)
  expect(idx.head).toEqual({ v: 1, k: 1, pos: 3, seen: w.map(messageKey) })
})

test('a failed call marks nothing; a command keeps its first result line; an error command is not indexed', () => {
  const w = [
    asst('', call('Write', { file_path: '/p/tools/new_file.py', content: 'x' }, { isError: true, text: 'denied' })),
    asst('', call('Bash', { command: 'npx -p typescript tsc -p .' }, { text: '\n  312 pass\n0 fail' })),
    asst('', call('Bash', { command: 'false' }, { isError: true, text: 'exit 1' })),
  ]
  const idx = mergeIndex(emptyIndex(), w, { k: 2 })
  expect(idx.entries.get('/p/tools/new_file.py')!.marks).toBe('')
  const c = idx.entries.get('npx -p typescript tsc -p .')!
  expect(c.kind).toBe('command')
  expect(c.result).toBe('312 pass')
  expect(idx.entries.has('false')).toBe(false)
})

test('MCP tool names and the person\'s prompts are indexed', () => {
  const w = [user('/loop continue the hammer'), asst('', call('mcp__shrink__recall', { question: 'q' }, { text: 'a' }))]
  const idx = mergeIndex(emptyIndex(), w, { k: 1 })
  expect(idx.entries.get('mcp__shrink__recall')!.typed).toBe(1)
  expect(idx.entries.get('/loop continue the hammer')!.kind).toBe('prompt')
})

test('kept messages and the earlier handoff are not counted twice', () => {
  const a = asst('see hooks/facts.ts', call('Read', { file_path: '/p/hooks/facts.ts' }, { text: 'x' }))
  const one = mergeIndex(emptyIndex(), [user('go'), a], { k: 1 })
  const two = mergeIndex(one, [user(`${HANDOFF_HEADER}\nhooks/facts.ts hooks/facts.ts`), a, asst('now hooks/facts.ts')], { k: 2 })
  expect(one.entries.get('hooks/facts.ts')!.typed).toBe(1)
  expect(two.entries.get('hooks/facts.ts')!.typed).toBe(2)
  expect(two.entries.get('hooks/facts.ts')!.win).toBe(1)
  expect(two.head.pos).toBe(3)
  expect(two.entries.get('hooks/facts.ts')!.refs).toEqual(['1:2', '2:3'])
})

test('refs keep the first and the newest', () => {
  let idx = emptyIndex()
  for (let k = 1; k <= 20; k++) idx = mergeIndex(idx, [asst(`k${k} uses tools/x_file.py`)], { k })
  const r = idx.entries.get('tools/x_file.py')!.refs
  expect(r.length).toBe(REFS_KEPT + 1)
  expect(r[0]).toBe('1:1')
  expect(r[r.length - 1]).toBe('20:1')
  expect(idx.entries.get('tools/x_file.py')!.lastSeg).toBe(20)
})

test('commands are capped, newest kept', () => {
  const w = Array.from({ length: COMMANDS_KEPT + 10 }, (_, i) => asst('', call('Bash', { command: `echo ${i}` }, { text: 'ok' })))
  const idx = mergeIndex(emptyIndex(), w, { k: 1 })
  expect([...idx.entries.values()].filter(e => e.kind === 'command').length).toBe(COMMANDS_KEPT)
  expect(idx.entries.has('echo 0')).toBe(false)
  expect(idx.entries.has(`echo ${COMMANDS_KEPT + 9}`)).toBe(true)
})

test('serialize and parse round-trip; a bad line is skipped; missing gives empty', () => {
  const idx = mergeIndex(emptyIndex(), [asst('uses tools/x_file.py and 0.2.12')], { k: 3 })
  const text = serializeIndex(idx)
  const back = parseIndex(text.replace('\n', '\n{not json\n{"item":1}\n'))
  expect(back.head).toEqual(idx.head)
  expect([...back.entries.values()]).toEqual([...idx.entries.values()])
  expect(parseIndex(undefined).entries.size).toBe(0)
  expect(parseIndex('garbage').head.k).toBe(0)
})

test('features follow RANK_WEIGHTS order', () => {
  const idx = mergeIndex(emptyIndex(), [asst('uses tools/x_file.py')], { k: 1 })
  const f = features(idx.entries.get('tools/x_file.py')!, 3, 10)
  expect(f.length).toBe(15)
  expect(f[0]).toBe(1)
  expect(f[3]).toBe(2 / 8)
  expect(f[4]).toBe(0)
  expect(f[9]).toBe(1)
})

test('a 45-shrink session merges in under 100 ms per shrink', () => {
  let idx = emptyIndex()
  let worst = 0
  for (let k = 1; k <= 45; k++) {
    const w = Array.from({ length: 300 }, (_, i) =>
      asst(`step ${k}.${i} edits src/mod_${i % 90}/file_${(i * 7) % 300}.ts v0.${k}.${i}`,
        call('Bash', { command: `python3 tools/run_${i % 40}.py --k ${k}` }, { text: `${i} pass` })))
    const t = Date.now()
    idx = mergeIndex(idx, w, { k })
    worst = Math.max(worst, Date.now() - t)
  }
  expect(worst < 100).toBe(true)
  expect(serializeIndex(idx).length < 2_000_000).toBe(true)
})

test('a fork seeds from the parent and keeps the parent\'s sid in refs', () => {
  let parent = emptyIndex()
  for (let k = 1; k <= 3; k++) parent = mergeIndex(parent, [asst(`k${k} uses tools/x_file.py`)], { k })
  const fork = mergeIndex(seedFromParent(parent, 'c7e2a914'), [asst('fork uses tools/x_file.py and docs/new_plan.md')], { k: 1 })
  const e = fork.entries.get('tools/x_file.py')!
  expect(e.refs).toEqual(['c7e2a914-1#1', 'c7e2a914-2#1', 'c7e2a914-3#1', '1:1'])
  expect(e.typed).toBe(4)
  expect(e.lastSeg).toBe(1)
  expect(fork.entries.get('docs/new_plan.md')!.refs).toEqual(['1:1'])
  expect(fork.head.k).toBe(1)
  // inherited entries sit before the fork's first shrink; already qualified refs (a fork of a fork) stay
  const seeded = seedFromParent(parseIndex(serializeIndex(fork)), 'c0ffee12')
  expect(seeded.entries.get('docs/new_plan.md')!.lastSeg).toBe(0)
  expect(seeded.entries.get('tools/x_file.py')!.refs[0]).toBe('c7e2a914-1#1')
  expect(seeded.entries.get('docs/new_plan.md')!.refs).toEqual(['c0ffee12-1#1'])
  expect(parent.entries.get('tools/x_file.py')!.refs[0]).toBe('1:1')
})

test('rankEntries: items only, best first by the fitted weights', () => {
  let idx = emptyIndex()
  idx = mergeIndex(idx, [asst('old tools/old_file.py once')], { k: 1 })
  for (let k = 2; k <= 6; k++) idx = mergeIndex(idx, [asst(`k${k} edits src/hot_path.ts again`)], { k })
  idx = mergeIndex(idx, [asst('run it', call('Bash', { command: 'echo hi' }, { text: 'hi' }))], { k: 7 })
  const ranked = rankEntries(idx)
  expect(ranked.map(e => e.item)).toEqual(['src/hot_path.ts', 'tools/old_file.py'])
  expect(RANK_WEIGHTS.length).toBe(features(ranked[0]!, 7, idx.head.pos).length)
})

test('itemsOf keeps a name with double underscores whole (mcp__x__recall)', () => {
  const items = itemsOf('I called `mcp__shrinktest__recall` once, with --allowedTools Read,Bash,mcp__shrinktest__recall').map(i => i.item)
  expect(items).toContain('mcp__shrinktest__recall')
  expect(items).not.toContain('mcp__shrinktest')
})
