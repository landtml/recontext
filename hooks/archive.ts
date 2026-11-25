// buildArchive: the old conversation as one greppable line per message (spec 3.4). Pure.
//
//   #412 user | the exact text ... (newlines as ⏎)
//   #413 assistant | text ... ⟦tool Bash: python3 tools/x.py --flag⟧
//   #414 tool Bash ok | first 1,500 chars of the result ... (full: transcript, tool_use_id toolu_...)
//
// `#n` is the message's 1-based position in the compacted list. A tool result gets a line
// of its own under the number of the message that carries it.

import type { SessionMessage, ToolUseSummary } from 'claude-code'

export const RESULT_CAP = 1500
export const WRITE_INPUT_CAP = 300

/** Tools whose inputs carry file content the file on disk already holds. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const PATH_KEYS = new Set(['file_path', 'notebook_path'])

export const lineNo = (index: number): number => index + 1

export function oneLine(s: string): string {
  return s.replace(/\r\n|[\n\r\u2028\u2029]/g, '⏎')
}

function cut(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap)}…[+${s.length - cap}]`
}

/** A call's input on one line; written content (Write/Edit text) is cut at `cap` (units pass a larger one, 0.2.9). */
export function formatInput(use: Pick<ToolUseSummary, 'tool' | 'input'>, cap: number = WRITE_INPUT_CAP): string {
  const input = use.input ?? {}
  if (use.tool === 'Bash' && typeof input.command === 'string') return input.command
  if (!WRITE_TOOLS.has(use.tool)) return JSON.stringify(input)
  const shown: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (PATH_KEYS.has(key)) shown[key] = value
    else if (typeof value === 'string') shown[key] = cut(value, cap)
    else if (typeof value === 'object' && value !== null) shown[key] = cut(JSON.stringify(value), cap)
    else shown[key] = value
  }
  return JSON.stringify(shown)
}

function resultLine(n: number, tool: string, id: string, text: string, isError: boolean): string {
  const body =
    text.length > RESULT_CAP
      ? `${text.slice(0, RESULT_CAP)}… (full: transcript, tool_use_id ${id})`
      : `${text} (tool_use_id ${id})`
  return `#${n} tool ${tool} ${isError ? 'error' : 'ok'} | ${oneLine(body)}`
}

export function buildArchive(messages: readonly SessionMessage[]): string {
  const toolName = new Map<string, string>()
  const hasResultRow = new Set<string>()
  for (const m of messages) {
    for (const u of m.toolUses ?? []) toolName.set(u.tool_use_id, u.tool)
    for (const r of m.toolResults ?? []) hasResultRow.add(r.tool_use_id)
  }

  const lines: string[] = []
  messages.forEach((m, i) => {
    const n = lineNo(i)
    const uses = m.toolUses ?? []
    const results = m.toolResults ?? []
    if (m.role === 'assistant') {
      const calls = uses.map(u => `⟦tool ${u.tool}: ${formatInput(u)}⟧`)
      lines.push(`#${n} assistant | ${oneLine([m.text, ...calls].filter(s => s !== '').join(' '))}`)
      // a result the engine attached to the call but no tool_result row carries
      for (const u of uses)
        if (u.text !== undefined && !hasResultRow.has(u.tool_use_id))
          lines.push(resultLine(n, u.tool, u.tool_use_id, u.text, u.isError === true))
      return
    }
    if (m.text !== '' || results.length === 0) lines.push(`#${n} user | ${oneLine(m.text)}`)
    for (const r of results)
      lines.push(resultLine(n, toolName.get(r.tool_use_id) ?? '?', r.tool_use_id, r.text, r.isError))
  })
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}
