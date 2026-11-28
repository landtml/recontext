// The shrink mod's session state (design 9): what the bar and the /shrink panel draw.

/** How full the context is, and where the next shrink fires (undefined: auto-compact off). */
export type ShrinkFill = { tokens?: number; threshold?: number }

/** One shrink, as the panel lists it. */
export type ShrinkRow = {
  k: number
  at: number
  trigger: string
  before?: number
  after?: number
  state: 'haiku' | 'none'
  haikuTokens?: number
  ms: number
  handoffPath?: string
}

/** One recall call, as the panel lists it. */
export type ShrinkRecallRow = {
  at: number
  question: string
  outcome: 'answer' | 'lookup' | 'not-found' | 'raw' | 'unavailable' | 'failed'
  tries: number
}

declare module 'claude-code' {
  interface PluginState {
    shrink: { fill: Shaped<ShrinkFill>; shrinks: Shaped<ShrinkRow[]>; recalls: Shaped<ShrinkRecallRow[]> }
  }
}
