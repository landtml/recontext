// Search over units (design 4.2). Pure, no embeddings: BM25 for words, exact matches for leads,
// identifiers and quoted phrases, fused by reciprocal rank fusion (as in governed-rag).

import { estimateTokens } from './budget'
import type { Unit } from './units'

/** `named`: the refs in the question or leads that this unit is, as they were written (0.2.4). */
export type Hit = { unit: Unit; score: number; named?: string[] }

const K1 = 1.2
const B = 0.75
const RRF_K = 60
const NEIGHBOUR_REACH = 3

const STOP = new Set(
  ('a an the is are was were be been being of to in on at for and or but with about from by as it its this that ' +
    'these those what which who whom why how when where did do does done we you i me my our your he she they them ' +
    'there here can could would should will shall may might has have had not no so if then than any some all into ' +
    'out up just also get got let lets please tell show give said say').split(' '),
)

const WORD = /[~/.]*[A-Za-z0-9_][\w./@~%-]*/g
const IDENT = /[/._]|[a-z]\d|\d[a-z]/

const splitCamel = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')

/** A light stem for plain words, the same on both sides of a match: -ing, -ed, plural -s. */
function stem(w: string): string {
  if (!/^[a-z]+$/.test(w) || w.length < 5) return w.length >= 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w
  if (w.endsWith('ing') && w.length - 3 >= 3) return w.slice(0, -3)
  if (w.endsWith('ed') && w.length - 2 >= 3) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Lowercased search tokens: whole paths and identifiers, plus their snake, dotted and camel parts. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const push = (t: string) => {
    const low = t.toLowerCase()
    if (low === '' || STOP.has(low) || (low.length === 1 && !/\d/.test(low))) return
    out.push(stem(low))
  }
  for (const raw of text.match(WORD) ?? []) {
    const word = raw.replace(/[./-]+$/, '')
    if (word === '') continue
    const parts = word.split(/[^A-Za-z0-9]+/).filter(Boolean)
    if (parts.length > 1 || /[A-Z]/.test(word.slice(1))) push(word)
    for (const p of parts) {
      const camel = splitCamel(p)
      if (camel.length > 1 && parts.length > 1) push(p)
      for (const c of camel) push(c)
    }
  }
  return out
}

type Ranked = { index: number; score: number }

/** Newer first on ties, with the current session ahead of any other. */
function tieOrder(units: readonly Unit[], current?: string) {
  return (a: number, b: number): number => {
    const ua = units[a]!
    const ub = units[b]!
    const ca = ua.session === current ? 1 : 0
    const cb = ub.session === current ? 1 : 0
    return cb - ca || ub.k - ua.k || ub.n - ua.n || (ub.ref < ua.ref ? -1 : ub.ref > ua.ref ? 1 : 0)
  }
}

function bm25(units: readonly Unit[], qTokens: readonly string[]): Ranked[] {
  const docs = units.map(u => tokenize(`${u.text} ${u.entities.join(' ')}`))
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, docs.length)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1)
  const need = qTokens.length <= 2 ? 1 : Math.ceil(qTokens.length * 0.4)
  const out: Ranked[] = []
  docs.forEach((d, index) => {
    const tf = new Map<string, number>()
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    let matched = 0
    for (const t of qTokens) {
      const f = tf.get(t)
      if (!f) continue
      matched++
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / Math.max(1, avgdl)))
    }
    if (matched >= need && score > 0) out.push({ index, score })
  })
  return out
}

/** Units holding any of the needles in their text or entities, by how many they hold. */
function exact(units: readonly Unit[], needles: readonly string[]): Ranked[] {
  if (needles.length === 0) return []
  const out: Ranked[] = []
  units.forEach((u, index) => {
    const text = u.text.toLowerCase()
    const ents = u.entities.map(e => e.toLowerCase())
    const score = needles.filter(n => text.includes(n) || ents.some(e => e.includes(n))).length
    if (score > 0) out.push({ index, score })
  })
  return out
}

/** `#n` / `#k:n` as handoffs write them, and a unit ref `<session>-<k>#<n>` as recall answers show them. */
const SHORT_REF = /(?<![\w#:])#(\d+)(?::(\d+))?(?![\d:])/g
const UNIT_REF = /(?<![\w-])([A-Za-z0-9]+)-(\d+)#(\d+)(?!\d)/g

/**
 * Units of the messages a question or lead names by ref (0.2.4), in archive order: `#k:n` and a unit ref name
 * one message; a plain `#n` means line n of the current session's latest archive, as in its latest handoff.
 * A tool result's line names the tool call it answers.
 */
function named(units: readonly Unit[], texts: readonly string[], current?: string): Map<number, string[]> {
  const latest = Math.max(0, ...units.filter(u => u.session === current).map(u => u.k))
  const want = new Map<string, Set<string>>()
  const ask = (key: string, as: string) => want.set(key, (want.get(key) ?? new Set()).add(as))
  for (const t of texts) {
    for (const m of t.matchAll(SHORT_REF)) ask(`${current}|${m[2] === undefined ? latest : m[1]}|${m[2] ?? m[1]}`, m[0])
    for (const m of t.matchAll(UNIT_REF)) ask(`${m[1]}|${m[2]}|${m[3]}`, m[0])
  }
  const out = new Map<number, string[]>()
  if (want.size === 0) return out
  // the order the refs were named in: the first MAX_PINNED are the ones that stay (0.2.10)
  const order = new Map([...want.keys()].map((key, i) => [key, i]))
  const first = new Map<number, number>()
  const add = (index: number, key: string) => {
    out.set(index, [...new Set([...(out.get(index) ?? []), ...want.get(key)!])])
    first.set(index, Math.min(first.get(index) ?? Infinity, order.get(key)!))
  }
  const found = new Set<string>()
  units.forEach((u, index) => {
    // a ref names a long result's first part only (0.2.9): later parts come in by their words, so 8 parts cannot fill the evidence
    if (u.part !== undefined) return
    // a ref may cite a tool's result line, which has no unit of its own: it names the call
    for (const n of [u.n, u.resultN]) {
      const key = `${u.session}|${u.k}|${n}`
      if (n !== undefined && want.has(key)) {
        add(index, key)
        found.add(key)
      }
    }
  })
  // shards from before 0.2.4 lack result lines: a line no unit claims goes to the tool calls just before it
  const fresh = new Set(units.filter(u => u.resultN !== undefined).map(u => `${u.session}|${u.k}`))
  for (const key of want.keys()) {
    if (found.has(key)) continue
    const [session, k, n] = key.split('|') as [string, string, string]
    if (fresh.has(`${session}|${k}`)) continue
    const before = units.filter(u => u.session === session && String(u.k) === k && u.n < Number(n) && u.tool !== undefined)
    const last = Math.max(-1, ...before.map(u => u.n))
    units.forEach((u, index) => {
      if (u.session === session && String(u.k) === k && u.n === last && u.tool !== undefined) add(index, key)
    })
  }
  return new Map([...out].sort((a, b) => first.get(a[0])! - first.get(b[0])! || a[0] - b[0]))
}

/**
 * The best units for a question, fused from: BM25 over words (a unit must hold at least 40% of
 * the question's words), the caller's leads (counted twice), identifiers in the question, and
 * exact quoted phrases, after the messages the question or leads name by ref (0.2.4). No list with a hit: [] (abstain).
 */
/** Most units a question can name by ref and get on top of the ranked hits. */
const MAX_PINNED = 4
/** Ranked hits a search returns by default, and the hits whose neighbours come before any extra hit. */
export const RANKED_HITS = 8

export function search(
  units: readonly Unit[],
  q: { question: string; leads?: readonly string[] },
  opts: { top?: number; currentSession?: string } = {},
): Hit[] {
  const qTokens = [...new Set(tokenize(q.question))]
  const leads = [...new Set((q.leads ?? []).map(l => l.trim().toLowerCase()).filter(l => l.length >= 2))]
  const idents = qTokens.filter(t => IDENT.test(t) && t.length >= 3 && !leads.includes(t))
  const phrases = [...q.question.matchAll(/"([^"]{2,})"/g)].map(m => m[1]!.toLowerCase())
  const tie = tieOrder(units, opts.currentSession)

  const lists: { ranked: Ranked[]; weight: number }[] = [
    { ranked: bm25(units, qTokens), weight: 1 },
    { ranked: exact(units, leads), weight: 2 },
    { ranked: exact(units, idents), weight: 1 },
    { ranked: exact(units, phrases), weight: 1 },
  ]
  const fused = new Map<number, number>()
  for (const { ranked, weight } of lists) {
    ranked.sort((a, b) => b.score - a.score || tie(a.index, b.index))
    ranked.forEach((r, rank) => fused.set(r.index, (fused.get(r.index) ?? 0) + weight / (RRF_K + rank + 1)))
  }
  // a message named by ref is the strongest lead there is: it goes first, whatever the words say
  const pinned = named(units, [q.question, ...(q.leads ?? [])], opts.currentSession)
  // a named unit past the first MAX_PINNED is not lost: it competes in the ranking like any other
  const kept = new Set([...pinned.keys()].slice(0, MAX_PINNED))
  const rest = [...fused.entries()].filter(([index]) => !kept.has(index)).sort((a, b) => b[1] - a[1] || tie(a[0], b[0]))
  // named units sit on top of the ranked list, not inside it: up to MAX_PINNED, in the order named (0.2.10)
  // a text archived twice (a kept message seen by two shrinks) is shown once, at its best rank (0.2.10)
  const texts = new Set([...kept].map(index => units[index]!.text))
  const uniq = rest.filter(([index]) => {
    const text = units[index]!.text
    if (texts.has(text)) return false
    texts.add(text)
    return true
  })
  return [...[...kept].map((index): [number, number] => [index, 1]), ...uniq.slice(0, opts.top ?? RANKED_HITS)]
    .map(([index, score]): Hit => {
      const as = kept.has(index) ? pinned.get(index) : undefined
      return { unit: units[index]!, score, ...(as ? { named: as } : {}) }
    })
}

/** What one unit adds to a reader request, counted high: its text and its `<evidence ...>` wrapper. */
export const unitTokens = (u: Unit): number => estimateTokens(u.text) + UNIT_WRAP_TOKENS
const UNIT_WRAP_TOKENS = 60

/**
 * Evidence for the hits: the hits themselves by rank, then the other units of the same message, then
 * neighbours at distance 1..3 in the same session and reset, until `maxChars` of text. Hits past the first
 * `core` (the extra slots pinned refs add, 0.2.10) come after all that, each only if it fits. Nothing goes past
 * `ceilingTokens` (design 4.3), hits included, except the first hit. Ordered by the session's first hit,
 * then k, n and ref.
 */
export function expand(units: readonly Unit[], all: readonly Hit[], maxChars: number, ceilingTokens = Infinity, core = Infinity): Unit[] {
  const hits = all.slice(0, core)
  const chosen = new Set<Unit>()
  let total = 0
  let tokens = 0
  const shown: Hit[] = []
  for (const h of hits) {
    if (chosen.has(h.unit)) continue
    if (chosen.size > 0 && tokens + unitTokens(h.unit) > ceilingTokens) continue
    chosen.add(h.unit)
    shown.push(h)
    total += h.unit.text.length
    tokens += unitTokens(h.unit)
  }
  const byPlace = new Map<string, Unit[]>()
  for (const u of units) {
    const key = `${u.session}|${u.k}|${u.n}`
    byPlace.set(key, [...(byPlace.get(key) ?? []), u])
  }
  outer: for (let d = 0; d <= NEIGHBOUR_REACH; d++) {
    for (const h of shown) {
      const ns = d === 0 ? [h.unit.n] : [h.unit.n - d, h.unit.n + d]
      for (const n of ns) {
        for (const u of byPlace.get(`${h.unit.session}|${h.unit.k}|${n}`) ?? []) {
          if (chosen.has(u) || u.part !== undefined) continue // parts of a long result come in only as hits (0.2.9)
          if (total + u.text.length > maxChars || tokens + unitTokens(u) > ceilingTokens) break outer
          chosen.add(u)
          total += u.text.length
          tokens += unitTokens(u)
        }
      }
    }
  }
  for (const h of all.slice(hits.length)) {
    if (chosen.has(h.unit) || total + h.unit.text.length > maxChars || tokens + unitTokens(h.unit) > ceilingTokens) continue
    chosen.add(h.unit)
    shown.push(h)
    total += h.unit.text.length
    tokens += unitTokens(h.unit)
  }
  const sessionOrder = new Map<string, number>()
  for (const h of shown) if (!sessionOrder.has(h.unit.session)) sessionOrder.set(h.unit.session, sessionOrder.size)
  return [...chosen].sort(
    (a, b) =>
      (sessionOrder.get(a.session) ?? 0) - (sessionOrder.get(b.session) ?? 0) ||
      a.k - b.k ||
      a.n - b.n ||
      (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
  )
}
