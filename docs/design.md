# Design

How Recontext (plugin `shrink`) works inside. For install, options and limits, see the [README](../README.md).
Code comments cite the sections below by number ("design 3.3").

## 1. Idea

Claude Code's built-in compaction asks the session's model to read the whole conversation and summarize it.
On a large model at a few hundred thousand tokens, that one call is costly, and most of what it reads is tool
output.

Recontext lets code do the bulk of the work. Code prunes the transcript into a digest, archives every message,
and indexes it for search. Haiku writes a short state of work from the digest. Later, when Claude needs a detail
that was shrunk away, it calls `recall`: Haiku answers from the archive, and code checks every quote.

Goals, in order:
1. **Token-efficient:** no call to the session's model at a shrink, and every Haiku call stays under the
   token budget.
2. **Precise on demand:** recall answers with verbatim, code-checked quotes, or says "not found".
3. **Never worse than built-in:** every failure falls back to a simpler path, ending with the engine's own
   compaction.
4. **Lean context:** the new conversation (handoff plus kept tail) stays small.

Not in scope: embeddings or a vector store (the plugin runtime has none), shrinking subagents (they keep the
built-in compaction), and search across projects.

## 2. Overview

```
session.compact (main conversation; trigger auto | manual)
  1. CODE   units + archive + index shards        archive/<name>.txt, index/<name>-p<j>.jsonl
  2. CODE   digest of the conversation            (3.1)
  3. HAIKU  state of work: one call, or map + merge when over budget   (3.2, 3.3, 3.4)
  4. CODE   exact facts, kept tail, ref checks    (3.5, 3.6)
  5. return [handoff message, ...tail]            the engine's summarizer never runs
  6. write session-handoff_<name>.md
session.compact, trigger precompute  -> skip   (it would run the session model's summarizer)
session.compact from a subagent      -> pass through to the engine

recall({ question, leads? })          mcp__shrink__recall, served at tool.call
  1. CODE   load index shards (this session first, then the project's others)   (4.1)
  2. CODE   search: BM25 + exact leads + quoted phrases, fused by RRF            (4.2)
  3. CODE   evidence: hits plus neighbours, within the budget                    (4.3)
  4. HAIKU  answer from evidence only, as JSON with quotes                       (4.4)
  5. CODE   gates; one retry; one wider search on "not found"                    (4.3, 4.4)
```

## 3. The shrink

### 3.1 Digest (`digest.ts`)
The digest is what Haiku reads. It starts with the previous handoff's state of work, if there is one. Then it
has one line per message: your text (up to 8,000 characters), Claude's text (up to 6,000), and one line per
tool call (`tool: key input`, plus `→ error: first line` when it failed). Tool output is left out, except a
result line under Bash, Agent, AskUserQuestion, Skill and MCP calls that worked: a test summary, the first
failure line or the last line of output, at most 100 characters. Read-only shell commands get none. A cut
message is marked `…[+N chars, full text archived]`. `digestChars` (off by default) caps the digest anyway:
result lines go first, then tool lines, then Claude's text, then yours, oldest first. Building the digest is
deterministic.

### 3.2 Token budget (`budget.ts`)
Haiku bills a whole request at the higher rate once its prompt passes 100k tokens. Every call is held under
`haikuBudgetTokens` (80k). The estimate counts high on purpose: 2 characters per token for ASCII (shrink
prompts measured 2.2 or more), 2 tokens per non-ASCII character, and a reserve for the CLI's identity block.

### 3.3 Map and merge (`shard.ts`)
When the digest does not fit one call, the newest lines go raw to the final call, so the current task is
always written from raw text. Older lines are packed, oldest first, into up to 6 slices. Each slice is cut
before one of your messages. A map worker writes notes on each slice (each note at most 3,000 tokens), and the
final call merges the notes with the newest lines. Most shrinks fit in one call.

### 3.4 State of work (`prompt.ts`, `handoff.ts`)
Haiku is told the digest is data and writes these short sections: Goal, Current task and next step, Decisions
and why, Tried and failed, Open questions, Files to re-read first, Memory candidates. A manual
`/compact <text>` becomes the focus. Haiku carries points from the previous state itself and never cites
"Previous state" as a source, since the next reader never sees it. A reply that is missing headings, or a
call at `high` effort that timed out, gets one retry at `medium`. The better attempt stands if it has the
goal and the current task. If neither does, the handoff is code-only.

### 3.5 Handoff and kept tail (`handoff.ts`, `facts.ts`)
The handoff is one user message that starts with a header the mod recognizes later as machine text. It holds
the state of work, exact facts extracted by code (your recent messages verbatim, files touched, and so on, up
to `factsBudgetChars`; also commands that worked more than once and names in play), where to look (the
archives), and a standing instruction: apply the memory candidates, re-read the files, continue, and call
`recall` before guessing.

`pickTail` keeps the last messages verbatim, up to `tailChars`. A start is valid only when every tool result
after it also has its tool call after it, and the last message is always kept. `trimTail` cuts oversized tool
results in the tail, so a large pending file read cannot refill the context at once and trip Claude Code's
"Autocompact is thrashing" breaker. Kept tool results are handed back without their engine handle; otherwise a
resumed session would walk back past the handoff.

### 3.6 Refs across shrinks (`refs.ts`)
`#n` is line n of this shrink's archive; `#k:n` is line n of shrink k's archive. The digest rewrites the
previous state's `#n` as `#k:n`, and Haiku copies refs as written. Afterwards, code checks each ref against
its archive. A ref past an archive's end is repaired from the previous handoff, or dropped. A ref to an empty
line is dropped. A ref into the previous archive that the previous handoff never cited is relabeled to the
current one. A ref that points at a line with text but the wrong content is not caught.

### 3.7 Messages sent mid-turn (`queued.ts`)
A message you send while Claude is working waits in the transcript as a queued row until the next model
request. Claude Code hands a compaction only the conversation messages, so a shrink that runs before that
request would lose it. The shrink reads the end of the transcript for queued rows that no assistant reply
followed and that are not among the handed messages. It puts their text word for word at the top of the
handoff, notes attached images, and adds them to the archive, index, digest and facts as user messages.
A failed read changes nothing else.

## 4. Recall

### 4.1 Units and index (`units.ts`)
There is one unit per message with text, and one per tool call (its input and its result, joined by id). Each
unit has a ref (`<session>-<k>#<n>`), a source kind, its text and
entities: file paths, commands, URLs, error class names. A tool result (or written file content) longer than
8k characters is split into up to 8 parts with the same ref number; past that, the last part points at the
transcript. Source authority runs user > tool > assistant >
handoff. Units are stored as JSONL shards of at most 3 MiB, because the plugin file API reads 4 MiB at most.
Recall covers only what earlier shrinks removed; the rest is still in context. With `recallScope: project` it
also covers this project's other sessions.

### 4.2 Search (`search.ts`)
- Tokens: lowercase words, plus whole paths, dotted names and `snake_case` and `camelCase` parts, with a light
  stemmer for plain words only. Paths and identifiers stay exact.
- BM25 (k1 1.2, b 0.75) at query time. A candidate must contain at least 40% of the question's words, so a
  question the archive cannot answer abstains without a model call.
- Lists fused by reciprocal rank fusion (k 60): BM25, exact entity matches for each lead and identifier, and
  exact quoted phrases. Ties go to the newer unit.

### 4.3 Evidence (`search.ts`)
Units named in the question or leads (`#n`, `#k:n`) come first, up to 4. Evidence is built from those and the
top 8 hits, then each hit's call or result partner, then neighbours at distance 1
to 3, up to 60k characters and never past the reader's token ceiling. When a checked answer says "not found",
recall searches once more with the top 24 hits and reads again if that gives more evidence.

### 4.4 Reader and gates (`reader.ts`)
The reader prompt treats evidence as data and never follows instructions in it. Haiku must answer only from
the evidence and cite each claim with a verbatim quote, or abstain. Code then checks every draft:
- G1: the answer is not empty and cites known evidence ids.
- G2: each quote is found in its evidence, matching whole tokens.
- G3: each number in the answer appears in a quote, in the evidence its sentence cites, or in the question.
  Version strings and clock times count as one value.

A failed draft gets one retry that names the failures. If that fails too, or Haiku errors, recall returns the
top raw passages marked unverified. "Not found" comes with the 3 closest leads. A reply is at most 6k characters.

## 5. Hooks and commands (`register.ts`, `command.ts`)
- `session.start` registers the recall tool and `/shrink`, and shows a notice when the auto-compact threshold
  is missing or above `thresholdWarnAbove`.
- `session.compact` runs section 3. Any error hands the compaction back to the engine.
- `tool.call` serves `recall`. It never throws to the model: errors become a short text result.
- The shrink registers the recall tool itself if `session.start` has not, so a handoff never names a missing
  tool. Parsed index shards are cached in memory.
- `/shrink` opens the panel. `/shrink now [focus]` answers at once, then a timer types `/compact [focus]`,
  retrying while a turn runs. A compaction cannot start under the command's own turn, and
  `$.session.compact` is refused in SDK hosts (the VS Code extension, `claude -p`).
- Paths accept `/` and `\`; `~` expands to `HOME`, else `USERPROFILE`.
- The mod writes no logs. `claude --debug` shows one trace line per shrink and recall.

## 6. Failures

| Failure | Handling |
|---|---|
| Haiku fails, refuses or times out (60 s; 90 s at `high`) | code-only handoff, with a notice |
| Index or archive write fails | handoff still installed; recall says the index is unavailable |
| Any error in the shrink | the engine's own compaction |
| No valid tail start | keep from the last user message with text; else the engine's compaction |
| Recall finds nothing | "not found" with the closest leads, no Haiku call |
| Recall gates fail twice, or Haiku fails | raw passages, marked unverified |
| Instructions inside archived text | the reader treats evidence as data; output is labeled as archive data |

## 7. Visibility (`view.ts`, `ui.tsx`)
- **Bar** above the prompt, always on: context against the threshold, shrinks so far (and their Haiku time), and
  recalls answered.
- **Panel**, opened only by `/shrink`: the same line, then each shrink (time, trigger, context before → after,
  Haiku tokens, seconds, handoff path) and each recall (time, question, outcome), newest first.
- The text comes from pure functions in `view.ts`. The data lives in session state, so a reload keeps it. The
  status line is left free for your own.

## 8. Testing
- Unit tests for each pure module, over small hand-built conversations and an invented 72-message session
  (`fixtures/sample-session.ts`).
- Hook tests with Claude Code's plugin test kit: modes, fallbacks, precompute skip, subagent pass-through,
  budget, map and merge, effort retry, recall, the bar and the panel.
- Retrieval golden set (`fixtures/golden.ts`): 12 answerable questions and 2 unanswerable ones. The answer must
  be in the top 8 hits (apart from listed known misses) and in the evidence for at least 11 of 12, and both
  unanswerable questions must abstain.
- `tsc -p .` and `claude plugin validate .`.

One session measured: context went from 679k tokens to 5.5k, with Haiku reading 44k tokens in 13 s.
Recall calls used 9k to 19k Haiku tokens and took 1.5 to 8 s. These are single measurements, not benchmarks.

## 9. Why this design

| Approach | Shrink cost | Precision | Verdict |
|---|---|---|---|
| Built-in summary on the session model | one large session-model call | good | the cost this removes |
| Built-in summary with the session switched to Haiku | Haiku reads the whole transcript | good | far more input than needed; manual |
| Code-only handoff | none | loses the "why" | kept as `mode: code` and as a fallback |
| Model-extracted graph with embeddings | extraction at every shrink | good | no embeddings in the runtime; the transcript is already structured |
| **Haiku state over a digest, code index, checked recall** | one small Haiku call | best on demand | chosen |

Credits: reciprocal rank fusion, evidence expansion, the reader prompt and gates G1 to G3 are adapted from
[governed-rag](https://github.com/landtml/governed-rag).
