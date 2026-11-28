# Changelog

The project was renamed from claude-shrink-compaction to Recontext with 0.2.8. The plugin is still called
`shrink`, so `/shrink`, `/shrink now` and the `recall` tool keep their names.

Versions 0.2.0 to 0.3.0 also had local logging used during development. It is not part of the public
release and is left out of these notes.

## 0.3.0

- **Session index.** Every exact item the session has used (paths, files, ids, versions, code names, MCP tool
  names), each command that ran and each of your prompts go into an append-only index next to the archive,
  `items/<session>.jsonl`, with counts, read / write / edit marks and up to 8 `#k:n` refs. Code merges it at
  each shrink from the previous index and the new window only, so the cost of a shrink does not grow with the
  session.
- **Items in play.** The handoff shows a ranked slice of that index (up to about 5,000 tokens), grouped by folder,
  in place of "Files touched" and "Names in play". It is not limited to the last window: a file from three shrinks
  ago can still be listed. A last line gives the number of items not shown, which recall can find by exact name.
  Items the state of work already names are left out.
- **Exact lookup in recall.** A question or lead that names an indexed item is answered by code from the index
  and its archive lines, with no model call. When those lines do not answer the question by themselves, they
  come first and Haiku answers below them as before.
- Recall: a quote is checked against the full message, not the shortened archive line, so a correct quote
  from a long tool result is no longer rejected. An ISO timestamp counts as one value in the number check.
- Measured on a replay of 91 past shrinks: the handoff held 90% of the exact names that later work needed,
  against 50% for 0.2.12, at about 4,400 more tokens per handoff. No exact item was lost from one shrink to the
  next.

## 0.2.12

- Recall: an id made of hex digits that starts with a digit (a commit hash, a session id) is no longer read as
  a number by the number check.

## 0.2.11

- **Subagents are shrunk too.** A subagent's compaction runs the same Haiku shrink as the session, not the
  built-in summarizer on the session model. Its files carry their own label (`sub` and the first 8 letters and
  digits of the agent id), so its refs never point into the session's archives. It adds no toast and no panel
  row. Any error still hands the compaction to Claude Code.
- **Forks.** A handoff written by another session keeps that session's refs (`3f1c8a20-3#40`), and "Where to
  look" names the archive the fork continues. Before, a fork's first shrink read them as its own.
- A message that is only `/shrink now` or `/compact` is not read as the task and gets no digest line.
- The state of work says "not recorded" where it said "not in the digest", since the next reader never sees the
  digest.
- Recall number check: a number followed by a comma matches the same number in the source, and a clock time
  matches inside an ISO timestamp.

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
