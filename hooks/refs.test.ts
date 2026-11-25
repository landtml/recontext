import { expect, test } from 'claude-code/testing'
import { archiveEmptyLines, archiveLineCount, carriedLines, checkRefs, digestTalk, qualifyRefs } from './refs'

test('qualifyRefs: plain refs gain the archive number; qualified refs, headings and ids stay', () => {
  expect(qualifyRefs('Fixed G3 (#236, #84). Range #33–#39.', 4)).toBe('Fixed G3 (#4:236, #4:84). Range #4:33–#4:39.')
  expect(qualifyRefs('Kept (#3:12) and ## Goal and abc#5 and ### #200', 4)).toBe('Kept (#3:12) and ## Goal and abc#5 and ### #4:200')
})

test('checkRefs: in-range plain refs pass; qualified refs pass', () => {
  const r = checkRefs('Did it (#12, #3:400).', 149)
  expect(r).toEqual({ text: 'Did it (#12, #3:400).', plain: 1, qualified: 1, repaired: 0, dropped: 0, relabeled: 0, dead: 0 })
})

test('checkRefs: an out-of-range ref is repaired from the one archive the previous state names', () => {
  const r = checkRefs('Route refused (#236).', 149, 'Earlier: refused (#4:236).')
  expect(r.text).toBe('Route refused (#4:236).')
  expect(r.repaired).toBe(1)
})

test('checkRefs: an unknown out-of-range ref is dropped and the brackets stay tidy', () => {
  expect(checkRefs('A (#84, #433). B (#433). C #433 here.', 149).text).toBe('A (#84). B. C here.')
  expect(checkRefs('Range (#120–#500).', 149).text).toBe('Range (#120).')
  expect(checkRefs('Ambiguous (#300).', 149, '(#2:300) (#3:300)').dropped).toBe(1)
})

test('carriedLines: counts lines copied from the previous state, ignoring refs', () => {
  const prev = '- The timer route is refused in SDK hosts (#4:236).\n- short'
  expect(carriedLines('- The timer route is refused in SDK hosts (#236).\n- something new and different here', prev)).toBe(1)
})

test('checkRefs: a qualified ref past its archive\'s end is dropped, and never used to repair', () => {
  const lines = new Map([[4, 300]])
  const r = checkRefs('Cheap (#4:433). Ok (#4:236). Stale (#433).', 149, '(#4:433)', lines)
  expect(r.text).toBe('Cheap. Ok (#4:236). Stale.')
  expect(r).toMatchObject({ qualified: 1, repaired: 0, dropped: 2 })
})

test('archiveLineCount: the last #n of an archive', () => {
  expect(archiveLineCount('#1 user | a\n#2 assistant | b ⏎ #9 not a line\n#3 user | c\n')).toBe(3)
  expect(archiveLineCount('')).toBe(0)
})

test('checkRefs: a #prevK:n the previous state never cited is a line of this conversation, made plain (0.2.4)', () => {
  // regression: a shrink cited its own new lines as #5:n, which point at unrelated lines of archive 5
  const lines = new Map([[5, 194]])
  const r = checkRefs('Task 6 done (#5:135). Tasks 1–5 (#5:15–#5:184).', 183, 'Tasks 1–5 (#5:15–#5:184).', lines, 5)
  expect(r.text).toBe('Task 6 done (#135). Tasks 1–5 (#5:15–#5:184).')
  expect(r).toMatchObject({ plain: 1, qualified: 2, relabeled: 1, dropped: 0 })
})

test('checkRefs: a #prevK:n that Haiku read in the conversation is a real old ref and stays (0.2.5)', () => {
  // a recall answer after the last shrink quoted #5:120, which the previous state never cited
  const lines = new Map([[5, 194]])
  const seen = '## Conversation\n#40 tool mcp__shrink__recall: ... → "the route was refused" (#5:120)'
  const r = checkRefs('Route refused (#5:120). New work (#5:135).', 183, 'Tasks (#5:15).', lines, 5, seen)
  expect(r.text).toBe('Route refused (#5:120). New work (#135).')
  expect(r).toMatchObject({ relabeled: 1, qualified: 1, plain: 1 })
  // without the conversation it would have been relabeled too (the 0.2.4 behaviour)
  expect(checkRefs('Route refused (#5:120).', 183, 'Tasks (#5:15).', lines, 5).text).toBe('Route refused (#120).')
})

test('checkRefs: relabeling needs the previous shrink number and a line this archive has (0.2.4)', () => {
  const lines = new Map([[4, 300], [5, 194]])
  const r = checkRefs('Past this end (#5:190). Other archive (#4:20).', 183, '', lines, 5)
  expect(r.text).toBe('Past this end (#5:190). Other archive (#4:20).')
  expect(r.relabeled).toBe(0)
})

// ---------------------------------------------------------------- 0.2.7: refs to empty lines are dead
test('archiveEmptyLines: a number is empty only when every line under it has no text', () => {
  const archive = [
    '#1 user | hello',
    '#2 assistant | ',
    '#3 assistant |',
    '#4 assistant | ⟦tool Bash: ls⟧',
    '#5 user | ',
    '#5 tool Bash ok | a.txt (tool_use_id t1)',
    '#6 assistant | a | b',
    '#7 assistant |   ',
  ].join('\n')
  expect([...archiveEmptyLines(archive)].sort((a, b) => a - b)).toEqual([2, 3, 7])
  expect(archiveEmptyLines('').size).toBe(0)
})

test('checkRefs: a qualified ref to an empty line is dead and dropped; brackets stay tidy (0.2.7)', () => {
  // regression: refs to empty thinking-only lines were carried through several handoffs
  const lines = new Map([[6, 300], [8, 200]])
  const empty = { byArchive: new Map([[6, new Set([84, 236])], [8, new Set([49])]]) }
  const r = checkRefs('Cost (#6:84). Refused (#6:236, #6:173). Fix (#8:49, #9:171). Ok (#6:57).', 122, '', lines, undefined, '', empty)
  expect(r.text).toBe('Cost. Refused (#6:173). Fix (#9:171). Ok (#6:57).')
  expect(r).toMatchObject({ dead: 3, dropped: 0, qualified: 3 })
})

test('checkRefs: a plain ref to an empty line of this archive is dropped, never repaired from the previous state (0.2.7)', () => {
  // regression: repairing #121 from the previous state gave #5:121, a sed command on another topic
  const lines = new Map([[4, 300]])
  const empty = { current: new Set([12, 40]), byArchive: new Map([[4, new Set<number>()]]) }
  const r = checkRefs('Old point (#40). Miscounted (#12). Fine (#13). Past end (#200).', 122, 'Old point (#4:40). (#4:200)', lines, undefined, '', empty)
  expect(r.text).toBe('Old point. Miscounted. Fine (#13). Past end (#4:200).')
  expect(r).toMatchObject({ repaired: 1, dead: 2, plain: 1, dropped: 0 })
})

test('refs inside code spans are mentions: no check, repair, drop or qualifying touches them (0.2.7)', () => {
  // regression: a handoff named three test questions as (`#7`, `#2:17`, `#10`)
  const lines = new Map([[2, 10]])
  const empty = { current: new Set([7, 10]) }
  const r = checkRefs('Questions (`#7`, `#2:17`, `#10`) answered (#8). Gone (#7).', 50, '(#3:7)', lines, undefined, '', empty)
  expect(r.text).toBe('Questions (`#7`, `#2:17`, `#10`) answered (#8). Gone.')
  expect(r).toMatchObject({ plain: 1, qualified: 0, dead: 1, dropped: 0, repaired: 0 })
  expect(qualifyRefs('Ask `#7` (#7).', 8)).toBe('Ask `#7` (#8:7).')
})

test('checkRefs: an owner whose line is empty is never used to repair (0.2.7)', () => {
  const lines = new Map([[4, 300], [5, 300]])
  const empty = { byArchive: new Map([[4, new Set([236])], [5, new Set<number>()]]) }
  // #4:236 is empty, so #5:236 is the one usable owner
  expect(checkRefs('Route (#236).', 122, '(#4:236) (#5:236)', lines, undefined, '', empty).text).toBe('Route (#5:236).')
  // with both empty, nothing is left to repair from
  const both = { byArchive: new Map([[4, new Set([236])], [5, new Set([236])]]) }
  const r = checkRefs('Route (#236).', 122, '(#4:236) (#5:236)', lines, undefined, '', both)
  expect(r).toMatchObject({ text: 'Route.', dropped: 1, dead: 0 })
})

test('checkRefs: the ends of a range are kept even when empty, since the range spans real lines (0.2.7)', () => {
  const lines = new Map([[5, 194]])
  const empty = { current: new Set([20]), byArchive: new Map([[5, new Set([15])]]) }
  const r = checkRefs('Tasks (#5:15–#5:184). Work (#20–#30). Alone (#20).', 122, '', lines, undefined, '', empty)
  expect(r.text).toBe('Tasks (#5:15–#5:184). Work (#20–#30). Alone.')
  expect(r.dead).toBe(1)
})

test('checkRefs: without empty-line sets nothing is dead (the 0.2.6 behaviour)', () => {
  const r = checkRefs('Cost (#6:84). New (#12).', 122, '', new Map([[6, 300]]))
  expect(r).toMatchObject({ text: 'Cost (#6:84). New (#12).', dead: 0 })
})

test('digestTalk: counts lines that mention the digest, ignoring backticked text (0.2.8)', () => {
  const state = ['- The digest cut this line off (#12).', '- Fixed `digest.ts` cap (#4).', '- Digest: unrelated', '- nothing here', '- digests plural is not counted', '1. src/digest.ts (#12)', '- The digest.ts write-up (#15)'].join('\n')
  expect(digestTalk(state)).toBe(2)
  expect(digestTalk('')).toBe(0)
})
