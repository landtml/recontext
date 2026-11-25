// Token budget for Haiku calls (design 3.2). Pure.
//
// Haiku 5.5 bills a request whose prompt is over 100K tokens at the higher rate, all of it. Every call
// the mod makes is sized against `haikuBudgetTokens` with an estimate that over-counts on purpose:
// 2 chars per token for ASCII (the lowest ratio measured on shrink prompts was 2.2), 2 tokens
// per non-ASCII char (CJK, emoji, symbols), and a reserve for the CLI's identity block.

export const DEFAULT_BUDGET_TOKENS = 80000
/** The CLI's identity block that precedes `system` (its size is not exposed; calibration shows it). */
export const IDENTITY_RESERVE_TOKENS = 1000

/** Tokens a text may take, counted high. */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 2 + other * 2)
}

/** One request's estimated prompt tokens: identity block, system prompt and the user message. */
export function estimateRequest(system: string, prompt: string): number {
  return IDENTITY_RESERVE_TOKENS + estimateTokens(system) + estimateTokens(prompt)
}

/** The longest start of `text` whose estimate fits `tokens` (cut at a char; never splits a surrogate pair). */
export function cutToTokens(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text
  let used = 0
  let i = 0
  for (; i < text.length; i++) {
    const cost = text.charCodeAt(i) < 128 ? 0.5 : 2
    if (used + cost > tokens) break
    used += cost
  }
  const code = text.charCodeAt(i - 1)
  if (i > 0 && code >= 0xd800 && code <= 0xdbff) i--
  return text.slice(0, i)
}
