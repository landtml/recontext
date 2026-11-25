# Changelog

The project was renamed from claude-shrink-compaction to Recontext with 0.2.8. The plugin is still called
`shrink`, so `/shrink`, `/shrink now` and the `recall` tool keep their names.

Versions 0.2.0 to 0.2.10 also had local logging used during development. It is not part of the public
release and is left out of these notes.

## 0.2.10

- The digest gives some tool calls a short result line under the call: Bash, Agent, AskUserQuestion, Skill
  and MCP tools. It holds a test summary, the first failure line, or the last line of output (at most 100
  characters), so Haiku can tell that a call ran and what it returned. Read-only shell commands (`cat`, `grep`,
  `ls` and the like) get none. When the digest is over budget, result lines are dropped first.
- State-of-work prompt (rev 6): it explains result lines, and Haiku never cites "Previous state" as a source,
  since the next reader never sees it.
- Facts: a Write, Edit or Read that failed, or a shell write that a hook blocked, is not listed as a file
  touched. A shell's own error line wins over printed text that only mentions errors. Exit 1 from a last
  `grep`, `rg`, `diff` or `cmp` that printed other output (no match, files differ) is not a failed command.
- Refs: a dropped ref leaves no empty or filler-only brackets behind (`(see #42)` goes entirely).
- Recall: units named in the question or the leads (`#n`, `#k:n`) come first, up to 4, ahead of the ranked hits.

## 0.2.9

- Messages you send while Claude is working, which Claude has not seen yet when a shrink runs, are no longer
  lost. They open the handoff word for word under "Sent while Claude was working, not yet answered", and go
  into the archive and the index. Attached images are noted, not carried.
- Facts: answers you gave through AskUserQuestion count as your words; files changed by shell commands are
  listed (marked `S`); a failed command with no error text shows its exit code and last line. New sections:
  "Commands that worked" (repeated successful commands, side effects and secrets left out) and "Names in play"
  (identifiers in use). The "Files to re-read" list drops entries that are not paths. `factsBudgetChars` now
  defaults to 14000.
- Recall: written file content and long tool results are indexed in full, in up to 8 parts. The number check
  accepts a number found in the evidence the same sentence cites, treats version strings and clock times as
  one value, and quotes match text whose JSON escapes are decoded.
- Paths accept `\` as well as `/`, and the home folder falls back to `USERPROFILE`. Windows is still untested.

## 0.2.8

- Long messages are no longer cut at 2,000 characters before Haiku reads them. The limit is now 8,000 for your
  messages and 6,000 for Claude's; a shortened message is marked `…[+N chars, full text archived]`.
- State-of-work prompt (rev 5): Haiku reports what a shortened message says and never calls it cut off or
  unfinished, and never mentions the digest in the handoff.
- The session-start notice recommends the same setting as the README: `"autoCompactWindow": 200000` in
  `~/.claude/settings.json` (it named an environment variable and 350000 before). `thresholdWarnAbove` now
  defaults to 200000.

## 0.2.7

- A ref to an empty archive line (a message with no text) is dropped, not repaired from the previous handoff,
  which could land on an unrelated line.
- Refs inside backticks (code, file names) are left alone by the ref check.

## 0.2.6

- Token budget: every Haiku call stays under `haikuBudgetTokens` (default 80,000, estimated at 2 chars per
  token), below the 100K prompt size where Haiku's price rises. A larger shrink is split into up to 6 parts,
  each noted separately, and the newest part goes to the merge step word for word. `digestChars` is now off (0)
  by default.
- Reasoning effort is configurable (`stateEffort`, `mapEffort`, `recallEffort`, default `medium`). In a replay of
  13 recorded shrinks, `high` made no fewer errors at about twice the output. A timed-out call above `medium` is
  retried once at `medium`.
- Recall: hits go in by rank up to the budget. A "not found" answer triggers one retry with a wider search.

## 0.2.5

- A `#prevK:n` ref that also appears in the conversation Haiku read (a recall answer, a quoted request) is kept
  as written instead of relabeled.

## 0.2.4

- Haiku sometimes wrote new lines as refs into the previous archive. Such a ref that the previous handoff never
  cited is relabeled to the current archive.
- Recall questions can name refs (`#n`, `#k:n`); a tool call's ref includes its result line.
- Recall's number check (G3) counts every number a quote holds as sourced.

## 0.2.3

- Fix: resuming a shrunk session (`--resume`, reopening it) walked back past the handoff and reloaded the
  conversation the shrink had removed. Kept tool-result messages are now written fresh, so the resume chain
  goes through the handoff. Sessions shrunk by earlier versions still resume the old way.
- Archive refs stay valid across shrinks: refs carried from an earlier handoff are written `#k:n` (line n of
  shrink k's archive), code repairs or drops any ref that points past its archive, and "Where to look" lists
  every earlier archive.
- The state-of-work prompt treats the previous summary as possibly wrong: carried points are corrected from the
  newer conversation and gain no new detail.

## 0.2.2

- Recall usage is summed over all tries, not only the last one.

## 0.2.1

- Recall's number check (G3) no longer rejects evidence labels written without brackets, list numbering,
  digits inside names (`A7`, `REPORT-2.md`), or numbers the question itself gives. A number found nowhere is
  still rejected.
- `/shrink now` runs `/compact [focus]` instead of `$.session.compact`, which the VS Code extension and other
  SDK hosts refuse.
- Recall ranks its own earlier answers as summaries, below the original messages and tool output, so a wrong
  earlier answer is not trusted over the record.

## 0.2.0

- `/shrink now [focus]` shrinks on demand.

## 0.1.0

First public release.

- Compaction without a session-model call: code prunes the transcript into a digest, Haiku writes the state of
  work, code adds the exact facts and keeps the last messages word for word.
- `recall` tool: BM25 + exact-match search fused by reciprocal rank fusion over an index of the compacted
  conversation; Haiku answers with quotes that code checks; raw passages or "not found" otherwise.
- Fallbacks: code-only handoff when Haiku fails, Claude Code's own compaction when anything else fails.
- A bar above the prompt and a `/shrink` panel showing shrinks and recalls.
