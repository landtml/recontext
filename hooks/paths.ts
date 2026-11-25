// Path helpers that take `/` and `\` alike (design 5: Windows). Pure.

const lastSep = (p: string): number => Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))

/** The folder part of a path: `.` with no separator, the root itself for a file at the root. */
export function dirname(p: string): string {
  const at = lastSep(p)
  return at < 0 ? '.' : at === 0 ? p[0]! : p.slice(0, at)
}

/** A configured folder with `~` expanded (HOME, else USERPROFILE) and trailing separators dropped; undefined when
 *  it starts with `~` and neither is set. */
export function expandPath(p: string, env: { HOME?: string; USERPROFILE?: string }): string | undefined {
  const trimmed = (q: string): string => q.replace(/(.)[\\/]+$/, '$1')
  if (p !== '~' && !p.startsWith('~/') && !p.startsWith('~\\')) return trimmed(p)
  const home = env.HOME || env.USERPROFILE
  return home ? trimmed(`${home}${p.slice(1)}`) : undefined
}
