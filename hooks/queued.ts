// Messages sent while Claude was working (design 3.7). The engine queues them as `queued_command` attachment
// rows and shows them with the next model request; a shrink that runs before that request never sees them,
// since the hook gets only SessionMessages. So the shrink reads the transcript's tail for queued rows that no
// assistant row followed, and carries them. Pure: the caller reads the file.

import type { SessionMessage } from 'claude-code'

export type Queued = { text: string; images: number; origin: string; timestamp?: string }

/** How much of the transcript's end the shrink reads (one `$.fs.read`, its limit). */
export const TAIL_BYTES = 4 * 1024 * 1024
const TEXT_CAP = 4000

type Row = { type?: unknown; subtype?: unknown; isSidechain?: unknown; attachment?: { type?: unknown; prompt?: unknown; origin?: { kind?: unknown }; timestamp?: unknown } }

function queuedOf(a: NonNullable<Row['attachment']>): Queued | undefined {
  const texts: string[] = []
  let images = 0
  if (typeof a.prompt === 'string') texts.push(a.prompt)
  else if (Array.isArray(a.prompt))
    for (const b of a.prompt as { type?: unknown; text?: unknown }[]) {
      if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      else if (b?.type === 'image') images++
    }
  const text = texts.join('\n').trim()
  if (text === '' && images === 0) return undefined
  const origin = typeof a.origin?.kind === 'string' ? a.origin.kind : 'human'
  return { text, images, origin, ...(typeof a.timestamp === 'string' ? { timestamp: a.timestamp } : {}) }
}

/** The queued messages in a transcript tail that no assistant row (and no compaction) came after, oldest first.
 *  Lines that are not whole JSON rows (the cut first line of a tail read) are skipped. */
export function unansweredQueued(tail: string): Queued[] {
  let pending: Queued[] = []
  for (const line of tail.split('\n')) {
    if (!line.startsWith('{')) continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (row === null || typeof row !== 'object' || row.isSidechain === true) continue
    if (row.type === 'assistant' || (row.type === 'system' && row.subtype === 'compact_boundary')) pending = []
    else if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
      const q = queuedOf(row.attachment)
      if (q) pending.push(q)
    }
  }
  return pending
}

const imageNote = (n: number): string => (n > 0 ? `[${n} image${n === 1 ? '' : 's'} attached: not carried]` : '')
const label = (origin: string): string => (origin === 'human' ? '' : `(${origin.replace(/-/g, ' ')}) `)

/** The handoff's section for them: each verbatim (cut past 4000 chars), images noted, non-human ones labelled. */
export function queuedSection(q: readonly Queued[]): string {
  if (q.length === 0) return ''
  const items = q.map(x => {
    const text = x.text.length > TEXT_CAP ? `${x.text.slice(0, TEXT_CAP)}… [cut at ${TEXT_CAP} of ${x.text.length} chars]` : x.text
    return [text ? `${label(x.origin)}${text}` : '', imageNote(x.images)].filter(s => s !== '').join('\n')
  })
  return ['## Sent while Claude was working, not yet answered', items.join('\n\n')].join('\n')
}

/** The same messages as user messages, appended for the archive, index, digest and facts. */
export function queuedMessages(q: readonly Queued[]): SessionMessage[] {
  return q.map(x => ({ role: 'user', text: [x.text, imageNote(x.images)].filter(s => s !== '').join('\n'), toolUses: [] }))
}
