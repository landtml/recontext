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

/**
 * Refs of a handoff another session wrote (a fork, or a resume under a new id), as unit refs into that session's
 * archives (0.2.11): `#n` → `sid8-k#n`, `#j:n` → `sid8-j#n`. Recall reads that form; refs in code spans stay.
 */
export function qualifyForeign(text: string, sid8: string, k: number): string {
  return outsideCode(text, t =>
    t.replace(QUALIFIED, (_m, j: string, n: string) => `${sid8}-${j}#${n}`).replace(PLAIN, (_m, n: string) => `${sid8}-${k}#${n}`),
  )
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
      // an item left with only a filler word or two ("#42 area", "see #42") goes with its ref (0.2.10)
      const items = inner
        .split(/\s*,\s*/)
        .map(s => s.trim())
        .map(s => {
          if (!s.includes(DROP)) return s
          const words = s.split(DROP).join(' ').trim().split(/\s+/).filter(w => w !== '')
          return words.length <= 2 && words.every(w => FILLER.test(w)) ? '' : words.join(' ')
        })
        .filter(s => s !== '')
      return items.length ? `(${items.join(', ')})` : DROP
    })
    .replace(/\s*\u0000/g, '')
    .replace(/ +([.,;:])/g, '$1')
  return { text: tidy, plain, qualified, repaired, dropped, relabeled, dead }
}

const FILLER = /^(area|see|cf\.?|etc\.?|and|also|e\.g\.)$/

/** The last line number of an archive's text (`#n role ... | text` lines), 0 when none. */
export function archiveLineCount(archive: string): number {
  let last = 0
  for (const m of archive.matchAll(/^#(\d+) /gm)) last = Math.max(last, Number(m[1]))
  return last
}

/** Lines that are about the code, not the reader's work: a file name (`digest.ts`), or a code word (0.2.11). */
const TALK_GUARD = /digest\.[a-z]|digestParts|buildDigest|result line|digest line|digest cap|digest build/i
/** "not in the digest", "not yet visible in the digest": the reader cannot see the digest, so the verb is kept and the rest dropped. */
const TALK_NOT = /\b(not)( yet)? (?:(recorded|visible|shown|confirmed) )?in the digest\b/gi
/** "the digest does not show": the subject becomes the conversation. */
const TALK_DOES = /\bthe digest does not (show|confirm|say|mention)\b/gi

/**
 * Rewrite the handoff's talk about the digest (0.2.11) into talk about the conversation the reader sees. Applied outside
 * code spans, line by line; a line that is about the code (TALK_GUARD) stays whole. Returns the count of rewrites.
 */
export function cleanDigestTalk(text: string): { text: string; rewrites: number } {
  let rewrites = 0
  const out = text.split('\n').map(line => {
    if (TALK_GUARD.test(line)) return line
    return outsideCode(line, t =>
      outsideQuotes(t, u =>
        u
          .replace(TALK_NOT, (_m, not: string, yet: string | undefined, verb: string | undefined) => {
            rewrites++
            return `${not}${yet ?? ''} ${verb ?? 'recorded'}`
          })
          .replace(TALK_DOES, (m, verb: string) => {
            rewrites++
            return `${m.startsWith('T') ? 'The' : 'the'} conversation does not ${verb}`
          }),
      ),
    )
  })
  return { text: out.join('\n'), rewrites }
}

/** A short quoted phrase ("…" or “…”) names the words rather than saying them, so it stays as written. */
const QUOTED = /"[^"\n]{1,80}"|“[^”\n]{1,80}”/g

function outsideQuotes(text: string, f: (t: string) => string): string {
  let out = ''
  let at = 0
  for (const m of text.matchAll(QUOTED)) {
    out += f(text.slice(at, m.index)) + m[0]
    at = m.index! + m[0].length
  }
  return out + f(text.slice(at))
}
