// Archive refs across shrinks (0.2.3). Pure.
//
// A plain `#n` names line n of the current archive. Text carried from an earlier handoff names lines of an
// earlier archive, so the digest qualifies its refs as `#k:n` (line n of archive k) before Haiku sees them,
// and `checkRefs` repairs or drops any plain ref in Haiku's reply that is past the current archive's end.
// A ref to an empty archive line (a message with no text, such as a thinking-only turn) is dead: the digest
// never shows such lines, so the ref is stale or miscounted, and it is dropped (0.2.7). Refs inside `code
// spans` are mentions (a test question named `#7`), not citations, so no step touches them (0.2.7).

/** A plain ref: `#n` not inside a word, not after `:` digits, and not itself followed by `:` (that is `#k:n`). */
const PLAIN = /(?<![\w:#])#(\d+)(?![\d:])/g
/** A qualified ref `#k:n`. */
const QUALIFIED = /(?<![\w#])#(\d+):(\d+)(?!\d)/g

/** Run `edit` on `text` with its inline code spans held aside, then put them back unchanged. */
function outsideCode(text: string, edit: (t: string) => string): string {
  const spans: string[] = []
  const held = text.replace(/`[^`\n]*`/g, m => `\u0001${spans.push(m) - 1}\u0002`)
  return edit(held).replace(/\u0001(\d+)\u0002/g, (_m, i: string) => spans[Number(i)]!)
}

/** Rewrite every plain `#n` in `text` as `#k:n`; refs already qualified, and refs in code spans, stay as they are. */
export function qualifyRefs(text: string, k: number): string {
  return outsideCode(text, t => t.replace(PLAIN, (_m, n: string) => `#${k}:${n}`))
}

export type RefCheck = {
  text: string
  plain: number
  qualified: number
  repaired: number
  dropped: number
  relabeled: number
  /** Refs dropped because their line is empty (0.2.7); `dropped` counts only refs past an archive's end. */
  dead: number
}

/** Empty archive lines: for the current archive (`current`) and by earlier archive number (`byArchive`). */
export type EmptyLines = { current?: ReadonlySet<number>; byArchive?: ReadonlyMap<number, ReadonlySet<number>> }

/** The line numbers of `archive` whose every line has no text after `|` (0.2.7). */
export function archiveEmptyLines(archive: string): Set<number> {
  const seen = new Set<number>()
  const full = new Set<number>()
  for (const m of archive.matchAll(/^#(\d+) [^|\n]*\|(.*)$/gm)) {
    const n = Number(m[1])
    seen.add(n)
    if (m[2]!.trim() !== '') full.add(n)
  }
  return new Set([...seen].filter(n => !full.has(n)))
}

/** True when the ref at `offset` (of length `len`) in `s` is one end of a range such as `#a–#b`. */
const inRange = (s: string, offset: number, len: number) => /[–-]/.test(s[offset - 1] ?? '') || /^[–-]#/.test(s.slice(offset + len, offset + len + 2))

/**
 * Check Haiku's state of work against the current archive (`lines` lines). A plain `#n` past the end is
 * repaired to `#k:n` when the previous state names exactly one archive with line n, else dropped (with
 * the brackets or list commas left tidy). In-range plain refs pass unchanged; a qualified `#k:n` passes unless
 * `archiveLines` knows archive k and it has no line n. With `prevK`, a `#prevK:n` that neither `previous` nor
 * `seen` (the conversation Haiku read) contains is a line of this conversation that Haiku labelled with the
 * previous shrink's number, so it becomes `#n` (0.2.4). One that `seen` contains, such as a recall answer's ref
 * into the previous archive, was copied as written and stays (0.2.5). With `empty`, a ref to an empty line is
 * dead: it is dropped and counted in `dead`, never repaired, since a plain one is most often Haiku miscounting a
 * line of this conversation and a repair would look right while pointing elsewhere (0.2.7). The ends of a range
 * such as `#a–#b` are kept, since the range still spans real lines. Refs inside code spans are left alone.
 */
export function checkRefs(
  text: string,
  lines: number,
  previous = '',
  archiveLines?: ReadonlyMap<number, number>,
  prevK?: number,
  seen = '',
  empty: EmptyLines = {},
): RefCheck {
  let result: Omit<RefCheck, 'text'> | undefined
  const text2 = outsideCode(text, t => {
    const r = checkCited(t, lines, previous, archiveLines, prevK, seen, empty)
    result = r
    return r.text
  })
  return { ...result!, text: text2 }
}

function checkCited(
  text: string,
  lines: number,
  previous: string,
  archiveLines: ReadonlyMap<number, number> | undefined,
  prevK: number | undefined,
  seen: string,
  empty: EmptyLines,
): RefCheck {
  // a qualified ref past its archive's known end points nowhere (carried stale from before 0.2.3): drop it
  const DROP = '\u0000'
  let dropped = 0
  const known = (k: string, n: string) => {
    const max = archiveLines?.get(Number(k))
    return max === undefined || (Number(n) >= 1 && Number(n) <= max)
  }
  let relabeled = 0
  let dead = 0
  const blank = (k: string, n: string) => empty.byArchive?.get(Number(k))?.has(Number(n)) ?? false
  const cited = new Set([...`${previous}\n${seen}`.matchAll(QUALIFIED)].map(m => `${m[1]}:${m[2]}`))
  const mislabeled = (k: string, n: string) =>
    prevK !== undefined && Number(k) === prevK && !cited.has(`${k}:${n}`) && Number(n) >= 1 && Number(n) <= lines
  text = text.replace(QUALIFIED, (m, k: string, n: string, offset: number, s: string) => {
    if (mislabeled(k, n)) return (relabeled++, `#${n}`)
    if (!known(k, n)) return (dropped++, DROP)
    return blank(k, n) && !inRange(s, offset, m.length) ? (dead++, DROP) : m
  })
  const owners = new Map<string, Set<string>>()
  for (const m of previous.matchAll(QUALIFIED)) {
    if (!known(m[1]!, m[2]!) || blank(m[1]!, m[2]!)) continue
    const set = owners.get(m[2]!) ?? new Set<string>()
    set.add(m[1]!)
    owners.set(m[2]!, set)
  }
  let plain = 0
  let repaired = 0
  const out = text.replace(PLAIN, (m, n: string, offset: number, s: string) => {
    const inArchive = Number(n) >= 1 && Number(n) <= lines
    const isDead = inArchive && (empty.current?.has(Number(n)) ?? false) && !inRange(s, offset, m.length)
    if (inArchive && !isDead) {
      plain++
      return m
    }
    if (isDead) return (dead++, DROP)
    const ks = owners.get(n)
    if (ks?.size === 1) {
      repaired++
      return `#${[...ks][0]}:${n}`
    }
    dropped++
    return DROP
  })
  const qualified = [...out.matchAll(QUALIFIED)].length
  if (dropped + dead === 0) return { text: out, plain, qualified, repaired, dropped, relabeled, dead }
  // tidy: "#a–DROP" ranges keep their start; list commas and empty brackets go
  const tidy = out
    .replace(/[–-]\u0000/g, '')
    .replace(/\u0000[–-]/g, '')
    .replace(/\(([^()\n]*)\)/g, (whole, inner: string) => {
      if (!inner.includes(DROP)) return whole
      const items = inner
        .split(/\s*,\s*/)
        .map(s => s.trim())
        .filter(s => s !== DROP && s !== '')
      return items.length ? `(${items.join(', ')})` : DROP
    })
    .replace(/\s*\u0000/g, '')
    .replace(/ +([.,;:])/g, '$1')
  return { text: tidy, plain, qualified, repaired, dropped, relabeled, dead }
}

/** How many non-empty lines of `state` also appear, word for word, in `previous` (carried unchanged). */
export function carriedLines(state: string, previous: string): number {
  const norm = (s: string) => s.replace(/#\d+(:\d+)?/g, '#').replace(/\s+/g, ' ').trim().toLowerCase()
  const prev = new Set(previous.split('\n').map(norm).filter(l => l.length > 20))
  return state.split('\n').map(norm).filter(l => l.length > 20 && prev.has(l)).length
}

/** How many lines of `state` talk about the digest (0.2.8): counted only, never removed. The reader of a handoff never
 * sees the digest, so such a line is noise; the count shows whether prompt rev 5 stops it. Backticked text and file names
 * (`digest.ts`, `hooks/digest.test.ts`) are ignored: the conversation itself may be about such a file. */
export function digestTalk(state: string): number {
  return state.split('\n').filter(l => /\bdigest\b/i.test(l.replace(/`[^`]*`/g, '').replace(/\S*digest\.[a-z][\w.]*/gi, ''))).length
}

/** The last line number of an archive's text (`#n role ... | text` lines), 0 when none. */
export function archiveLineCount(archive: string): number {
  let last = 0
  for (const m of archive.matchAll(/^#(\d+) /gm)) last = Math.max(last, Number(m[1]))
  return last
}
