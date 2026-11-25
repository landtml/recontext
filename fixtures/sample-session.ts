// An invented Claude Code session, used as the test fixture for facts, archive, units, digest and search.
// A developer fixes rounding in a small invoicing CLI, adds a PDF footer, looks up VAT rules, and has two
// agents draft a CSV export. Nothing here comes from a real transcript; names, paths and numbers are made up.
// It covers what real sessions hold: system reminders and task notifications inside user messages, Read /
// Write / Edit calls, failed commands, hook denials, URLs inside shell commands, agents, and tool output much
// larger than the conversation around it. Message numbers (#n) are 1-based positions in `messages`.
import type { SessionMessage, ToolResultSummary, ToolUseSummary } from 'claude-code'

const ROOT = '/home/dev/projects/invoicer'
const MEMORY = '/home/dev/.claude/projects/-home-dev-projects-invoicer/memory'

let next = 0
type Call = { tool: string; input: Record<string, unknown>; out: string; isError?: boolean; agentId?: string }

const user = (text: string): SessionMessage[] => [{ role: 'user', text, toolUses: [] }]
const say = (text: string): SessionMessage[] => [{ role: 'assistant', text, toolUses: [] }]

/** An assistant message with tool calls, then the user message carrying their results. */
function act(text: string, ...calls: Call[]): SessionMessage[] {
  const uses: ToolUseSummary[] = []
  const results: ToolResultSummary[] = []
  for (const c of calls) {
    const id = `toolu_fixture_${String(++next).padStart(3, '0')}`
    uses.push({
      tool_use_id: id,
      tool: c.tool,
      input: c.input,
      text: c.out,
      ...(c.isError ? { isError: true as const } : {}),
      ...(c.agentId ? { agentId: c.agentId } : {}),
    })
    results.push({ tool_use_id: id, text: c.out, isError: c.isError ?? false })
  }
  return [
    { role: 'assistant', text, toolUses: uses },
    { role: 'user', text: '', toolUses: [], toolResults: results },
  ]
}

const bash = (command: string, out: string, isError = false): Call => ({ tool: 'Bash', input: { command, description: 'Run a command' }, out, isError })
const read = (file: string, out: string): Call => ({ tool: 'Read', input: { file_path: file }, out })
const edit = (file: string, from: string, to: string): Call => ({
  tool: 'Edit',
  input: { file_path: file, old_string: from, new_string: to },
  out: `The file ${file} has been updated successfully.`,
})
const write = (file: string, content: string, out = `File created successfully at: ${file}`, isError = false): Call => ({
  tool: 'Write',
  input: { file_path: file, content },
  out,
  isError,
})

/** A numbered source listing, as the Read tool returns it. */
const listing = (lines: string[]): string => lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')

const TOTALS = listing([
  '"""Invoice totals: line amounts, VAT and the gross total."""',
  'from dataclasses import dataclass',
  '',
  '',
  '@dataclass',
  'class Line:',
  '    description: str',
  '    hours: float',
  '    rate: float',
  '',
  '',
  'def line_amount(line: Line) -> float:',
  '    return line.hours * line.rate',
  '',
  '',
  'def net_total(lines: list[Line]) -> float:',
  '    total = 0.0',
  '    for line in lines:',
  '        total += line_amount(line)',
  '    return round(total, 2)',
  '',
  '',
  'def vat(net: float, rate: float = 0.20) -> float:',
  '    return round(net * rate, 2)',
  '',
  '',
  'def gross_total(lines: list[Line], vat_rate: float = 0.20) -> float:',
  '    net = net_total(lines)',
  '    return round(net + vat(net, vat_rate), 2)',
  ...Array.from({ length: 40 }, (_, i) => `# fixture padding line ${i + 1}: helpers for currency formatting and rounding notes`),
])

const PDF = listing([
  '"""Render an invoice as a one-page PDF with fpdf2."""',
  'from fpdf import FPDF',
  'from .config import load_config',
  'from .totals import gross_total, net_total, vat',
  '',
  '',
  'def render(invoice, path):',
  '    cfg = load_config()',
  '    pdf = FPDF()',
  '    pdf.add_page()',
  '    pdf.set_font("Helvetica", size=11)',
  '    pdf.cell(0, 10, f"Invoice {invoice.number}", new_x="LMARGIN", new_y="NEXT")',
  '    for line in invoice.lines:',
  '        pdf.cell(0, 8, f"{line.description}  {line.hours} h x {line.rate}", new_x="LMARGIN", new_y="NEXT")',
  '    net = net_total(invoice.lines)',
  '    pdf.cell(0, 8, f"Net {net:.2f}  VAT {vat(net):.2f}  Gross {gross_total(invoice.lines):.2f}")',
  '    pdf.output(path)',
  ...Array.from({ length: 60 }, (_, i) => `# fixture padding line ${i + 1}: layout constants, margins, fonts and page sizes`),
])

const CONFIG = listing([
  '"""Read the user config from ~/.config/invoicer/config.toml."""',
  'import tomllib',
  'from pathlib import Path',
  '',
  'CONFIG_PATH = Path.home() / ".config" / "invoicer" / "config.toml"',
  '',
  '',
  'def load_config() -> dict:',
  '    with CONFIG_PATH.open("rb") as f:',
  '        return tomllib.load(f)',
  ...Array.from({ length: 30 }, (_, i) => `# fixture padding line ${i + 1}: config keys supplier_name, supplier_address, vat_number`),
])

const EXPORT = listing([
  '"""Monthly CSV export of all invoices, for the accountant."""',
  'import csv',
  'from datetime import timezone',
  '',
  'COLUMNS = ["number", "date", "client", "net", "vat", "gross"]',
  '',
  '',
  'def export_month(invoices, month: str, path) -> int:',
  '    rows = [i for i in invoices if i.issued_at.astimezone(timezone.utc).strftime("%Y-%m") == month]',
  '    with open(path, "w", newline="") as f:',
  '        w = csv.writer(f)',
  '        w.writerow(COLUMNS)',
  '        for i in rows:',
  '            w.writerow([i.number, i.issued_at.date().isoformat(), i.client, i.net, i.vat, i.gross])',
  '    return len(rows)',
  ...Array.from({ length: 50 }, (_, i) => `# fixture padding line ${i + 1}: CSV dialect notes and column formatting`),
])

const PYTEST_ROUNDING = [
  'Exit code 1',
  '============================= test session starts ==============================',
  'collected 12 items',
  '',
  'tests/test_totals.py ..........F.                                        [100%]',
  '',
  '=================================== FAILURES ===================================',
  '__________________________ test_acme_march_gross ______________________________',
  '    def test_acme_march_gross():',
  '        lines = acme_march_lines()',
  '>       assert gross_total(lines) == 1205.00',
  'E       AssertionError: assert 1204.99 == 1205.0',
  '',
  'tests/test_totals.py:88: AssertionError',
  ...Array.from({ length: 30 }, (_, i) => `    frame ${i + 1}: totals.py line_amount -> float accumulation detail`),
  '=========================== short test summary info ============================',
  'FAILED tests/test_totals.py::test_acme_march_gross - AssertionError: assert 1204.99 == 1205.0',
  '1 failed, 11 passed in 0.38s',
].join('\n')

const PYTEST_MONTH = [
  'Exit code 1',
  'collected 21 items',
  'tests/test_export.py ....F.                                              [100%]',
  '___________________________ test_export_month_boundary ___________________________',
  '    invoice INV-0142 issued 2026-03-31 23:30 Europe/London (BST)',
  '>   assert export_month(invoices, "2026-03", out) == 4',
  'E   assert 3 == 4',
  'E    INV-0142 was exported under 2026-04: grouped by its UTC date',
  ...Array.from({ length: 30 }, (_, i) => `    frame ${i + 1}: export.py export_month timezone conversion detail`),
  'FAILED tests/test_export.py::test_export_month_boundary - assert 3 == 4',
  '1 failed, 20 passed in 0.52s',
].join('\n')

export const messages: SessionMessage[] = [
  // #1
  ...user(
    'Hi Claude, the invoicer CLI rounds totals wrong for some clients. Can you look at how totals are computed in invoicer/totals.py and why the Acme March invoice shows 1,204.99 instead of 1,205.00?',
  ),
  // #2-3
  ...act("I'll read the totals module first.", read(`${ROOT}/invoicer/totals.py`, TOTALS)),
  // #4-5
  ...act('', bash(`cd ${ROOT} && python -m pytest -q tests/test_totals.py`, PYTEST_ROUNDING, true)),
  // #6-7
  ...act(
    'The bug: net_total adds float line amounts and rounds once at the end, so 0.1-cent float errors pile up and the Acme March gross lands on 1204.99. Fix: compute each line with Decimal, round each line to the cent with ROUND_HALF_UP, then sum.',
    edit(`${ROOT}/invoicer/totals.py`, '    return line.hours * line.rate', '    return (Decimal(str(line.hours)) * Decimal(str(line.rate))).quantize(CENT, ROUND_HALF_UP)'),
  ),
  // #8-9
  ...act('', bash(`cd ${ROOT} && python -m pytest -q`, '12 passed in 0.41s')),
  // #10
  ...say('Fixed: totals now use Decimal with per-line rounding (ROUND_HALF_UP). The Acme March invoice comes to 1,205.00 and all 12 tests pass.'),
  // #11
  ...user(
    "<system-reminder>The user opened the file invoicer/pdf.py in the IDE.</system-reminder>great. now the PDF footer should show the VAT number from config. config lives in ~/.config/invoicer/config.toml but don't put my real VAT number in tests",
  ),
  // #12-13
  ...act('', read(`${ROOT}/invoicer/pdf.py`, PDF)),
  // #14-15
  ...act('', read(`${ROOT}/invoicer/config.py`, CONFIG)),
  // #16-17
  ...act(
    'Adding a footer line with the VAT number read from config (key vat_number).',
    edit(`${ROOT}/invoicer/pdf.py`, '    pdf.output(path)', '    pdf.set_y(-20)\n    pdf.cell(0, 8, f"VAT {cfg[\'vat_number\']}")\n    pdf.output(path)'),
  ),
  // #18-19
  ...act(
    '',
    write(
      `${ROOT}/tests/test_pdf_footer.py`,
      'from reportlab.pdfgen import canvas\n\ndef test_footer_has_vat(tmp_path, fake_config):\n    fake_config(vat_number="GB000000000")\n    ...\n',
    ),
  ),
  // #20-21
  ...act(
    '',
    bash(
      `cd ${ROOT} && python -m pytest -q tests/test_pdf_footer.py`,
      "Exit code 1\nImportError while importing test module tests/test_pdf_footer.py\nE   ModuleNotFoundError: No module named 'reportlab'",
      true,
    ),
  ),
  // #22-23
  ...act('', bash('pip list 2>/dev/null | grep -i -E "pdf|report"', 'fpdf2          2.7.9\npypdf          4.2.0')),
  // #24-25
  ...act(
    'The project renders with fpdf2 and has pypdf for reading; reportlab is not installed, so the test imported the wrong library. Rewriting the test to read the footer text back with pypdf.',
    edit(`${ROOT}/tests/test_pdf_footer.py`, 'from reportlab.pdfgen import canvas', 'from pypdf import PdfReader'),
  ),
  // #26-27
  ...act('', bash(`cd ${ROOT} && python -m pytest -q`, '14 passed in 0.47s')),
  // #28
  ...say('The footer now shows the VAT number from config. The test uses the fake number GB000000000, never yours. 14 tests pass.'),
  // #29
  ...user('can you check what the current UK VAT standard rate is and whether invoices need the supplier address too'),
  // #30-31
  ...act(
    '',
    bash(
      'curl -s "https://www.gov.uk/vat-rates"; echo',
      'VAT rates\nStandard rate: 20% - most goods and services\nReduced rate: 5% - some goods and services, for example home energy\nZero rate: 0% - zero-rated goods and services, for example most food and children\'s clothes',
    ),
  ),
  // #32-33
  ...act(
    '',
    bash(
      "curl -sL 'https://www.gov.uk/invoice-your-customers/what-an-invoice-must-include'; echo",
      'What an invoice must include\nYour invoice must include: a unique identification number; your company name, address and contact information; the company name and address of the customer you are invoicing; a clear description of what you are charging for; the date the goods or service were provided; the date of the invoice; the amount(s) being charged; VAT amount if applicable; the total amount owed.\nIf you are VAT registered, include your VAT registration number.',
    ),
  ),
  // #34
  ...say(
    'The UK standard VAT rate is 20% (reduced 5%, zero 0%). An invoice must include your company name and address, the customer\'s name and address, a unique invoice number, the dates, the amounts, and, if you are VAT registered, your VAT registration number. So yes, the supplier address is required.',
  ),
  // #35
  ...user("ok add the address too. and please don't push anything or send invoices to anyone, this repo is local only"),
  // #36-37
  ...act(
    'Saving that as a memory first.',
    write(
      `${MEMORY}/local-only-no-push.md`,
      '---\nname: local-only-no-push\n---\nThe invoicer repo is local only: never push, never send invoices.\n',
      'PreToolUse:Write hook error: invoicer guard: Write outside the project folder is blocked',
      true,
    ),
  ),
  // #38-39
  ...act(
    'The project guard blocks writes outside the repo, so I noted the rule in the project CLAUDE.md instead.',
    edit(`${ROOT}/CLAUDE.md`, '## Rules', '## Rules\n- Local only: never git push, never email or upload invoices.'),
  ),
  // #40-41
  ...act(
    '',
    edit(`${ROOT}/invoicer/pdf.py`, '    pdf.set_y(-20)', '    pdf.set_y(-26)\n    pdf.multi_cell(0, 6, f"{cfg[\'supplier_name\']}\\n{cfg[\'supplier_address\']}")'),
  ),
  // #42-43
  ...act(
    'Cleaning up in case the blocked memory write left a partial file.',
    bash(`rm ${MEMORY}/local-only-no-push.md`, 'PreToolUse:Bash hook error: invoicer guard: rm outside the project folder is blocked', true),
  ),
  // #44-45
  ...act('', bash(`cd ${ROOT} && python -m pytest -q`, '15 passed in 0.49s')),
  // #46
  ...say('The PDF footer now prints the supplier name and address (config keys supplier_name and supplier_address) above the VAT number. 15 tests pass. Nothing was pushed or sent.'),
  // #47
  ...user('now export: we need a CSV export of all invoices per month for the accountant. spin up two agents, one to draft the exporter and one to write the tests'),
  // #48-49
  ...act(
    '',
    {
      tool: 'Agent',
      input: { description: 'Draft monthly CSV exporter', subagent_type: 'general-purpose', prompt: 'Write invoicer/export.py: export_month(invoices, month, path) writing one CSV row per invoice.' },
      out: 'Async agent launched successfully.\nagentId: a1b2c3d4e5f6a7b8c',
      agentId: 'a1b2c3d4e5f6a7b8c',
    },
  ),
  // #50-51
  ...act(
    '',
    {
      tool: 'Agent',
      input: { description: 'Tests for the CSV exporter', subagent_type: 'general-purpose', prompt: 'Write tests/test_export.py covering month filtering, columns and the month boundary in Europe/London.' },
      out: 'Async agent launched successfully.\nagentId: b9c8d7e6f5a4b3c2d',
      agentId: 'b9c8d7e6f5a4b3c2d',
    },
  ),
  // #52
  ...user('<task-notification>agent a1b2c3d4e5f6a7b8c completed: wrote invoicer/export.py with export_month</task-notification>'),
  // #53
  ...user('<task-notification>agent b9c8d7e6f5a4b3c2d completed: wrote tests/test_export.py (6 tests)</task-notification>'),
  // #54-55
  ...act('', read(`${ROOT}/invoicer/export.py`, EXPORT)),
  // #56-57
  ...act('', bash(`cd ${ROOT} && python -m pytest -q`, PYTEST_MONTH, true)),
  // #58-59
  ...act(
    'Month boundary bug: export_month groups invoices by their UTC date, so INV-0142, issued 23:30 on 31 March in London (BST), lands in April. Fix: group by the invoice\'s local date in Europe/London.',
    edit(
      `${ROOT}/invoicer/export.py`,
      'i.issued_at.astimezone(timezone.utc).strftime("%Y-%m")',
      'i.issued_at.astimezone(LONDON).strftime("%Y-%m")',
    ),
  ),
  // #60-61
  ...act('', bash(`cd ${ROOT} && python -m pytest -q`, '21 passed in 0.55s')),
  // #62
  ...say('Export done: `invoicer export --month 2026-03` writes invoices-2026-03.csv with the columns number, date, client, net, vat, gross, grouped by the London date. 21 tests pass.'),
  // #63
  ...user('what is still open before i can tag v0.3?'),
  // #64-65
  ...act(
    '',
    bash(
      `cd ${ROOT} && git log --oneline -5; git status --short`,
      '4e1d2c7 Per-line Decimal rounding\n9a0b3f1 VAT footer\n77c2e10 Supplier address on invoices\n2f9d8a4 Monthly CSV export\n0c3e5b9 v0.2\n M CHANGELOG.md\n?? notes.txt',
    ),
  ),
  // #66
  ...say('Open before v0.3: a CHANGELOG entry for rounding, footer, address and export; a README section for the export command; and requirements-dev.txt still lists reportlab, which nothing uses any more.'),
  // #67
  ...user('remove the stale reportlab line and update the changelog, then stop'),
  // #68-69
  ...act('', edit(`${ROOT}/requirements-dev.txt`, 'reportlab==4.1.0\n', '')),
  // #70-71
  ...act('', edit(`${ROOT}/CHANGELOG.md`, '## Unreleased', '## Unreleased\n- Per-line Decimal rounding\n- VAT number and supplier address in the PDF footer\n- Monthly CSV export')),
  // #72
  ...say('Done: reportlab is gone from requirements-dev.txt and the changelog lists the four changes. Not tagged and not pushed; the README section for export is still open.'),
]
