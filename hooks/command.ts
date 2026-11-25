// The /shrink command's arguments and help text, and the mod version (design 5). Pure.

export const MOD_VERSION = '0.2.8'

export type ShrinkCommand = { kind: 'panel' } | { kind: 'now'; focus?: string } | { kind: 'help' } | { kind: 'unknown'; word: string }

/** `/shrink` → panel; `/shrink now [focus text]` → shrink now; `/shrink help`. */
export function parseShrinkArgs(args: string): ShrinkCommand {
  const t = args.trim()
  if (t === '') return { kind: 'panel' }
  const [word = ''] = t.split(/\s+/)
  const w = word.toLowerCase()
  if (w === 'now' || w === 'run') {
    const focus = t.slice(word.length).trim()
    return focus === '' ? { kind: 'now' } : { kind: 'now', focus }
  }
  if (w === 'help' || w === '?' || w === '-h' || w === '--help') return { kind: 'help' }
  if (w === 'panel' || w === 'show') return { kind: 'panel' }
  return { kind: 'unknown', word }
}

export const SHRINK_HELP = [
  '/shrink            open the shrink panel (context fill, shrinks and recalls of this session)',
  '/shrink now        shrink the conversation now (same as /compact, run by the shrink mod)',
  '/shrink now <text> shrink now, telling Haiku what the state of work should focus on',
].join('\n')
