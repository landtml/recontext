// The bar above the prompt and the /shrink panel (design 7). The text comes from view.ts;
// this file keeps the session state they read and draws it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { ShrinkFill, ShrinkRecallRow, ShrinkRow } from '../types'
import { bandText, recallLine, shrinkLine } from './view'

export const PANE_ID = 'shrink'
export const PANE_TITLE = 'Shrink'
const KEEP = 50

// Change a shape tag when its fields change: it declines what an earlier version stored.
const fill = atom({ plugin: 'shrink', key: 'fill' } as const, {}, { shape: 'fill-1' })
const shrinks = atom({ plugin: 'shrink', key: 'shrinks' } as const, [], { shape: 'shrinks-1' })
const recalls = atom({ plugin: 'shrink', key: 'recalls' } as const, [], { shape: 'recalls-1' })

/** The last measured context size. */
export async function fillTokens($: EngineInterface): Promise<number | undefined> {
  return (await read($, fill)).tokens
}

/**
 * A new fill reading. A token count that arrives while the newest shrink has no "after" yet
 * becomes that shrink's "after" (the first measure past it).
 */
export async function recordFill($: EngineInterface, next: ShrinkFill): Promise<ShrinkRow | undefined> {
  await update($, fill, cur => ({
    tokens: next.tokens ?? cur.tokens,
    threshold: 'threshold' in next ? next.threshold : cur.threshold,
  }))
  if (next.tokens === undefined) return undefined
  const tokens = next.tokens
  let completed: ShrinkRow | undefined
  await update($, shrinks, list => {
    const last = list[list.length - 1]
    if (!last || last.after !== undefined) return list
    completed = { ...last, after: tokens }
    return [...list.slice(0, -1), completed]
  })
  return completed
}

/** The last fill reading, tokens and threshold. */
export async function fillNow($: EngineInterface): Promise<ShrinkFill> {
  return read($, fill)
}

export async function recordShrink($: EngineInterface, row: ShrinkRow): Promise<void> {
  await update($, shrinks, list => [...list, row].slice(-KEEP))
}

export async function recordRecall($: EngineInterface, row: ShrinkRecallRow): Promise<void> {
  await update($, recalls, list => [...list, row].slice(-KEEP))
}

export function registerUi(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isCollapsed) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{bandText(await read($, fill), await read($, shrinks), await read($, recalls))}</Text>
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [f, s, r] = [await read($, fill), await read($, shrinks), await read($, recalls)]
    const room = Math.max(6, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24) - 6)
    const shrinkRows = [...s].reverse().slice(0, Math.ceil(room / 2))
    const recallRows = [...r].reverse().slice(0, Math.floor(room / 2))
    return (
      <Box flexDirection="column">
        <Text>{bandText(f, s, r)}</Text>
        <Text bold>Shrinks (newest first)</Text>
        {shrinkRows.length === 0 ? <Text dimColor>No shrinks yet in this session.</Text> : shrinkRows.map(row => <Text>{shrinkLine(row)}</Text>)}
        <Text bold>Recalls (newest first)</Text>
        {recallRows.length === 0 ? <Text dimColor>No recalls yet in this session.</Text> : recallRows.map(row => <Text>{recallLine(row)}</Text>)}
        {s.length > 0 && s[s.length - 1]!.handoffPath ? <Text dimColor>Latest handoff: {s[s.length - 1]!.handoffPath}</Text> : null}
      </Box>
    )
  })
}
