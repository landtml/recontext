/** Small helpers shared by several hook modules (one copy each). */
export const pad = (n: number): string => String(n).padStart(2, '0')
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
export function stringsOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(stringsOf).join(' ')
  if (v !== null && typeof v === 'object') return Object.values(v).map(stringsOf).join(' ')
  return ''
}
export const ENGINE_SUMMARY = 'This session is being continued from a previous conversation'
