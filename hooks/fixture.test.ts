// buildFacts and buildArchive over an invented session (fixtures/sample-session.ts). Expected values were
// counted by hand from the fixture.
import { expect, test } from 'claude-code/testing'
import { messages } from '../fixtures/sample-session'
import { buildArchive } from './archive'
import { buildFacts } from './facts'

const OPTS = {
  verbatimUserMessages: 5,
  factsBudgetChars: 20000,
  archivePath: '/h/archive/2026-01-15_c0ffee12-1.txt',
  transcriptPath: '/p/c0ffee12-0000-4000-8000-000000000000.jsonl',
}
const ROOT = '/home/dev/projects/invoicer'
const MEMORY = '/home/dev/.claude/projects/-home-dev-projects-invoicer/memory'

const section = (facts: string, title: string): string[] => {
  const start = facts.indexOf(`\n## ${title}`)
  if (start < 0) return []
  const body = facts.slice(start + 1).split('\n').slice(1)
  const end = body.findIndex(l => l.startsWith('## ') || l === '---')
  return (end < 0 ? body : body.slice(0, end)).filter(l => l !== '')
}

const facts = buildFacts(messages, OPTS)

test('the fixture is what the counts were made from', () => {
  expect(messages).toHaveLength(72)
})

test("user messages: 7 of the person's, 5 verbatim; the reminder and 2 task notifications left out", () => {
  const headings = section(facts, "The user's last messages, verbatim").filter(l => l.startsWith('### #'))
  expect(headings).toEqual(['### #29', '### #35', '### #47', '### #63', '### #67'])
  const earlier = section(facts, 'Earlier messages')
  expect(earlier).toHaveLength(2)
  expect(earlier[0]).toStartWith('- #1 Hi Claude, the invoicer CLI rounds totals wrong')
  expect(earlier[1]).toStartWith('- #11 great. now the PDF footer should show the VAT number')
  expect(facts).not.toContain('<system-reminder>')
  expect(facts).not.toContain('<task-notification>')
})

test('files touched: 8 paths with hand-counted actions, by last touch; the blocked memory Write is not one (0.2.10)', () => {
  expect(section(facts, 'Files touched')).toEqual([
    `- ${ROOT}/invoicer/totals.py  R1 E1`,
    `- ${ROOT}/invoicer/config.py  R1`,
    `- ${ROOT}/tests/test_pdf_footer.py  W1 E1`,
    `- ${ROOT}/CLAUDE.md  E1`,
    `- ${ROOT}/invoicer/pdf.py  R1 E2`,
    `- ${ROOT}/invoicer/export.py  R1 E1`,
    `- ${ROOT}/requirements-dev.txt  E1`,
    `- ${ROOT}/CHANGELOG.md  E1`,
  ])
})

test('failed commands: 5 (three test runs, two guard denials), each with its error line', () => {
  const failed = section(facts, 'Failed commands and errors')
  expect(failed).toHaveLength(5)
  expect(failed[0]).toStartWith(`- #4 Bash: cd ${ROOT} && python -m pytest -q tests/test_totals.py`)
  expect(failed[0]).toEndWith('→ E       AssertionError: assert 1204.99 == 1205.0')
  expect(failed[1]).toStartWith('- #20 Bash:')
  expect(failed[1]).toEndWith('→ ImportError while importing test module tests/test_pdf_footer.py')
  expect(failed[2]).toStartWith(`- #36 Write: ${MEMORY}/local-only-no-push.md`)
  expect(failed[2]).toContain('→ PreToolUse:Write hook error: invoicer guard: Write outside the project folder')
  expect(failed[3]).toStartWith(`- #42 Bash: rm ${MEMORY}/`)
  expect(failed[3]).toContain('→ PreToolUse:Bash hook error: invoicer guard: rm outside the project folder')
  expect(failed[4]).toEndWith('→ FAILED tests/test_export.py::test_export_month_boundary - assert 3 == 4')
})

test('URLs: 2 distinct, from Bash commands, trailing quote and semicolon cut', () => {
  expect(section(facts, 'URLs fetched')).toEqual([
    '- https://www.gov.uk/vat-rates',
    '- https://www.gov.uk/invoice-your-customers/what-an-invoice-must-include',
  ])
})

test('agents: 2, with their agent ids', () => {
  expect(section(facts, 'Agents spawned')).toEqual([
    '- #48 Draft monthly CSV exporter [general-purpose] agentId a1b2c3d4e5f6a7b8c',
    '- #50 Tests for the CSV exporter [general-purpose] agentId b9c8d7e6f5a4b3c2d',
  ])
})

test('the facts fit the budget, well under it for 72 messages', () => {
  expect(facts.length).toBeLessThanOrEqual(OPTS.factsBudgetChars)
  expect(buildFacts(messages, { ...OPTS, factsBudgetChars: 3000 }).length).toBeLessThanOrEqual(3000)
})

test('the archive has one line per message plus one per tool result, none with a raw newline', () => {
  const archive = buildArchive(messages)
  const lines = archive.split('\n').filter(l => l !== '')
  const results = messages.reduce((n, m) => n + (m.toolResults?.length ?? 0), 0)
  const userWithText = messages.filter(m => m.role === 'user' && (m.text !== '' || !m.toolResults?.length)).length
  const assistants = messages.filter(m => m.role === 'assistant').length
  expect(lines).toHaveLength(assistants + userWithText + results)
  for (const line of lines) expect(line).toMatch(/^#\d+ (user|assistant|tool \S+ (ok|error)) \| /)
  expect(archive).toContain('#5 tool Bash error | Exit code 1⏎')
})
