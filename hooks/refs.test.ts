import { expect, test } from 'claude-code/testing'
import { archiveEmptyLines, archiveLineCount, checkRefs, cleanDigestTalk, qualifyForeign, qualifyRefs } from './refs'

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

// ---------------------------------------------------------------- 0.2.10: ref tidy
test('checkRefs: a dropped ref with a filler word leaves no empty bracket (0.2.10)', () => {
  // "(#42 area)" with #42 an empty line was left as "( area)"
  const empty = { current: new Set([42]) }
  const check = (t: string) => checkRefs(t, 100, '', undefined, undefined, '', empty).text
  expect(check('It works (#42 area).')).toBe('It works.')
  expect(check('It works (#42 area, #5:7).')).toBe('It works (#5:7).')
  expect(check('Done (see #42).')).toBe('Done.')
  expect(check('Done (main loop #42).')).toBe('Done (main loop).')
  expect(check('Kept (real words here).')).toBe('Kept (real words here).')
})

test("qualifyForeign: plain and qualified refs name the other session's archives; code spans stay (0.2.11)", () => {
  expect(qualifyForeign('see #40 and #2:17, `#7`, range #33–#39.', '4a9e7c13', 3)).toBe(
    'see 4a9e7c13-3#40 and 4a9e7c13-2#17, `#7`, range 4a9e7c13-3#33–4a9e7c13-3#39.',
  )
})

test('checkRefs: a ref into another session’s archive is neither repaired, relabelled nor dropped (0.2.11)', () => {
  const r = checkRefs('Gate fixed (4a9e7c13-3#900, #5).', 10, 'Earlier (4a9e7c13-3#900).', new Map([[1, 50]]), 1)
  expect(r.text).toBe('Gate fixed (4a9e7c13-3#900, #5).')
  expect(r.dropped + r.repaired + r.relabeled).toBe(0)
})

test('cleanDigestTalk (0.2.11): "not in the digest" becomes "not recorded", with the same verb or "yet"', () => {
  expect(cleanDigestTalk('- its result is not in the digest')).toEqual({ text: '- its result is not recorded', rewrites: 1 })
  expect(cleanDigestTalk('- results are not yet in the digest')).toEqual({ text: '- results are not yet recorded', rewrites: 1 })
  expect(cleanDigestTalk('- the write is not visible in the digest')).toEqual({ text: '- the write is not visible', rewrites: 1 })
  expect(cleanDigestTalk('- was not confirmed in the digest')).toEqual({ text: '- was not confirmed', rewrites: 1 })
  expect(cleanDigestTalk('- Not in the digest, sadly.')).toEqual({ text: '- Not recorded, sadly.', rewrites: 1 })
  expect(cleanDigestTalk('- its result is not in the digest.')).toEqual({ text: '- its result is not recorded.', rewrites: 1 })
})

test('cleanDigestTalk (0.2.11): "the digest does not show/confirm/say/mention" becomes "the conversation does not ..."', () => {
  expect(cleanDigestTalk('the digest does not show whether it ran.')).toEqual({ text: 'the conversation does not show whether it ran.', rewrites: 1 })
  expect(cleanDigestTalk('The digest does not confirm the fix.')).toEqual({ text: 'The conversation does not confirm the fix.', rewrites: 1 })
})

test('cleanDigestTalk (0.2.11): each match counts one rewrite', () => {
  const r = cleanDigestTalk('Its result is not in the digest; the digest does not say so.')
  expect(r).toEqual({ text: 'Its result is not recorded; the conversation does not say so.', rewrites: 2 })
})

test('cleanDigestTalk (0.2.11): code spans, file names, code words, and other digest talk are left alone', () => {
  const kept = [
    '`not in the digest` is the phrase',
    'Change digest.ts so results are not in the digest',
    'the result line is not in the digest yet',
    'that answer is cut off in the digest',
    'the reader never sees the digest',
    'the shrink digest cap is 320k',
  ]
  for (const line of kept) expect(cleanDigestTalk(line)).toEqual({ text: line, rewrites: 0 })
  const multi = kept.join('\n')
  expect(cleanDigestTalk(multi)).toEqual({ text: multi, rewrites: 0 })
  expect(cleanDigestTalk('')).toEqual({ text: '', rewrites: 0 })
})

test('cleanDigestTalk (0.2.11): a guarded line stays whole, other lines are rewritten', () => {
  const text = 'the buildDigest result is not in the digest\n- its result is not in the digest'
  expect(cleanDigestTalk(text)).toEqual({ text: 'the buildDigest result is not in the digest\n- its result is not recorded', rewrites: 1 })
})

test('cleanDigestTalk (0.2.11): a quoted phrase is a mention, not talk, and stays', () => {
  const t = 'Improvements: (4) "not in the digest" wording; (5) “the digest does not show” too. Its result is not in the digest.'
  expect(cleanDigestTalk(t)).toEqual({
    text: 'Improvements: (4) "not in the digest" wording; (5) “the digest does not show” too. Its result is not recorded.',
    rewrites: 1,
  })
})
