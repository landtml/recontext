import { expect, test } from 'claude-code/testing'
import { HANDOFF_HEADER, STATE_SECTIONS, missingSections } from './prompt'

test('the state of work has seven sections, in order', () => {
  expect(STATE_SECTIONS).toEqual([
    'Goal',
    'Current task and next step',
    'Decisions and why',
    'Tried and failed',
    'Open questions',
    'Files to re-read first',
    'Memory candidates',
  ])
})

test('the handoff header names the shrink mod', () => {
  expect(HANDOFF_HEADER).toBe('# Handoff (this conversation was shrunk by the shrink mod)')
})

test('missingSections lists the sections a state of work left out', () => {
  const all = STATE_SECTIONS.map(s => `## ${s}\nx`).join('\n')
  expect(missingSections(all)).toEqual([])
  const some = '## Goal\nx\n### Decisions and why\n7. **Tried and failed:**\nsee Open questions'
  expect(missingSections(some)).toEqual(['Current task and next step', 'Open questions', 'Files to re-read first', 'Memory candidates'])
})
