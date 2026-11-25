// Shared names for the text the shrink mod writes. Pure.

/** Opens every handoff message, so a later shrink knows it as machine text, never the user's words. */
export const HANDOFF_HEADER = '# Handoff (this conversation was shrunk by the shrink mod)'

/** The sections of the state of work, in order (design 3.4). */
export const STATE_SECTIONS = [
  'Goal',
  'Current task and next step',
  'Decisions and why',
  'Tried and failed',
  'Open questions',
  'Files to re-read first',
  'Memory candidates',
] as const

export type Where = { archivePath?: string; transcriptPath?: string }

/**
 * The sections a state of work left out. A heading counts at any level, numbered or bold, as long
 * as it opens its line.
 */
export function missingSections(text: string): string[] {
  const lines = text.split(/\r?\n/).map(l =>
    l
      .replace(/^\s*#{0,6}\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^[*_]+/, '')
      .trim()
      .toLowerCase(),
  )
  return STATE_SECTIONS.filter(name => !lines.some(l => l.startsWith(name.toLowerCase())))
}
