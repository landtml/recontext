import { expect, test } from 'claude-code/testing'
import { IDENTITY_RESERVE_TOKENS, cutToTokens, estimateRequest, estimateTokens } from './budget'

test('the estimate counts 2 ASCII chars a token and 2 tokens a non-ASCII char, rounded up', () => {
  expect(estimateTokens('')).toBe(0)
  expect(estimateTokens('abcd')).toBe(2)
  expect(estimateTokens('abc')).toBe(2)
  expect(estimateTokens('é')).toBe(2)
  expect(estimateTokens('日本')).toBe(4)
  expect(estimateTokens('#12 tool Bash: ls → ok')).toBe(Math.ceil(21 / 2 + 2))
})

test('a request adds the identity reserve to its system prompt and message', () => {
  expect(estimateRequest('abcd', 'ef')).toBe(IDENTITY_RESERVE_TOKENS + 2 + 1)
})

test('cutToTokens keeps the longest start that fits, never half an emoji', () => {
  expect(cutToTokens('abcdef', 2)).toBe('abcd')
  expect(cutToTokens('abc', 5)).toBe('abc')
  const cut = cutToTokens('ab😀cd', 4)
  expect(cut).toBe('ab')
  expect(estimateTokens(cutToTokens('x'.repeat(1000) + '日'.repeat(100), 600))).toBeLessThanOrEqual(600)
})
