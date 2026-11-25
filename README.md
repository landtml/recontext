<p align="center"><img src="assets/logo.png" alt="Recontext logo" width="160"></p>

<h1 align="center">Recontext</h1>

<p align="center">
  <strong>Token-efficient, low-loss context compaction for Claude Code.</strong><br>
  A script prunes the conversation, Haiku distills it, and a recall tool brings back any exact detail later.
</p>

<p align="center">
  <a href="https://github.com/landtml/recontext/releases/latest"><img alt="Release" src="https://img.shields.io/badge/release-v0.2.10-D63A3A"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-D97757">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&amp;logoColor=white">
  <img alt="Tests: 189 passing" src="https://img.shields.io/badge/tests-189%20passing-2EA44F">
  <img alt="Platforms: Linux, macOS" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-555">
  <img alt="Haiku calls under 80k tokens" src="https://img.shields.io/badge/Haiku%20calls-%E2%89%A480k%20tokens-6E56CF">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#limits">Limits</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

---

- **Your session model is never called.** Built-in compaction has Opus (or whatever you run) re-read the whole
  conversation. Recontext prunes it with code and has Haiku write the summary: measured at 5–22k tokens in and
  8–19 seconds per shrink.
- **Exact facts are copied, not summarized.** Your last messages, failed commands, files and URLs are extracted
  by code word for word, and the most recent messages are kept as they were.
- **Nothing is thrown away.** The full conversation goes to a local archive. The `recall` tool answers questions
  about it with quotes that code checks word for word.
- **Cost stays predictable.** Every Haiku call stays under a token budget (80k by default), below Haiku's
  higher price tier. Larger conversations are split into parts.
- **It can't break compaction.** Any error falls back to Claude Code's built-in compaction.

```
shrink ▸ context 112k / 180k ▓▓▓▓▓▓░░░░ · 2 shrinks (Haiku, ~3 s each) · 3 recalls (2 answered)
```
<sup>The status bar above the prompt: context fill against the shrink point, shrinks so far, recalls answered.</sup>

## Why

Claude Code's built-in compaction asks the session's model, often Opus, to read the whole conversation and
summarize it. At a few hundred thousand tokens that one call is expensive. On a subscription it can take a
noticeable share of your usage limit, every time it runs.

Recontext moves the heavy lifting to code and a small model:

| | Built-in compaction | Recontext |
|---|---|---|
| Who reads the old conversation | the session model, all of it | code; Haiku reads a pruned digest |
| Measured example (679k-token session) | one large session-model call | Haiku: 44k tokens in, 2.7k out, 13 s; context 679k → 5.5k |
| Exact details after compaction | only what the summary kept | `recall` fetches them from the archive, with checked quotes |
| If something fails | n/a | code-only handoff, then the built-in compaction |

## How it works

<p align="center"><img src="assets/architecture.png" alt="Recontext architecture: the shrink pipeline, the archive on disk, and the recall pipeline" width="100%"></p>

```
compaction (auto threshold or /compact)
  1. CODE   split the conversation into units: each message, each tool call with its result
  2. CODE   write the archive (one line per message) and a search index, next to the transcript
  3. CODE   build a digest: your words, Claude's words, one line per tool call; bulky tool output dropped,
            a one-line result kept for calls such as tests
            (a very long message is shortened and marked, its full text stays in the archive)
  4. HAIKU  write a short state of work from the digest: goal, next step, decisions and why, what failed.
            Every Haiku call stays under a token budget (default 80k, below Haiku's higher price tier);
            a larger digest is split into up to 6 parts, noted separately, then merged
  5. CODE   check every archive ref (#n, or #k:n for shrink k's archive): refs past an archive's end are
            repaired from the previous handoff or dropped, refs to empty lines are dropped
  6. CODE   add exact facts: your last messages verbatim, files touched, failed commands, URLs, agents,
            and any message you sent while Claude was working
  7. CODE   keep the last messages word for word (tool calls paired with their results)
  -> the new context is the handoff plus that tail; the session model is never called

recall(question, leads)   a tool Claude calls when it needs a detail from before a shrink
  1. CODE   search the index: BM25 + exact matches on paths and identifiers + quoted phrases,
            fused by reciprocal rank fusion; neighbours and call/result partners added as evidence
  2. HAIKU  answer from the evidence only, citing each claim with a quote
  3. CODE   check that every cited id exists, every quote appears verbatim, every number is quoted;
            one retry, then the raw passages marked unverified; "not found" when nothing matches,
            after one retry with a wider search
```

The full design, including the options that were considered and rejected, is in
[docs/design.md](docs/design.md).

## Compatibility

| Where | Works |
|---|---|
| Claude Code in the terminal (CLI) | ✅ |
| Claude Code in VS Code | ✅ |
| Claude desktop app, **Code** mode | ✅ |
| Cloud sessions (claude.ai/code) | ❌ unless the plugin is set up in that environment |

Runs on **Linux** and **macOS**. **Windows** is untested.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add landtml/recontext
/plugin install shrink@recontext
```

Pick a scope when asked (user scope loads it in every session).
From a shell, in one step: `claude plugin install shrink --marketplace landtml/recontext`
(adds the marketplace first if needed; `--scope user|project|local`, default user).
In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace**
(`landtml/recontext`) → **Add plugin**.

### Turn on automatic shrinking

Recontext does not decide when to compact. Claude Code does, and Recontext replaces what happens at that
moment. Set it up once and every compaction after that is a shrink, with nothing to run by hand.

Add these two lines to `~/.claude/settings.json` (merge them into the existing object if the file has one):

```json
{
  "autoCompactEnabled": true,
  "autoCompactWindow": 200000
}
```

Then start a new session. Settings are read when a session starts, so an open session keeps its old ones.

**What happens from then on:**

1. Claude Code measures the context against the window you set. With `200000`, it starts a compaction at about
   180k tokens and keeps the rest as a reserve.
2. Recontext takes over that compaction. Code prunes the conversation into a digest, Haiku writes the state
   of work, and code adds the exact facts and keeps your last messages word for word. Your session model
   (Opus, for example) is not called.
3. The session continues from the handoff. The bar above the prompt counts the shrink, and the `recall` tool
   can fetch any exact detail from the archive later.

**Choosing the window.** `200000` is a good default. Because a shrink costs few tokens, compacting earlier
costs little, and a smaller context makes every later request smaller and faster. A larger window (for example
`400000` on a 1M-token model) compacts less often but sends more tokens on every request in between. Claude
Code treats any value below `100000` as `100000`.

**If it is off.** With `autoCompactEnabled: false`, nothing compacts on its own. At session start the mod shows a notice when auto-compaction is off or the
threshold is above `thresholdWarnAbove` (default `200000`).

**By hand.** You can shrink at any time with `/compact`, optionally with a focus: `/compact the export bug`.
`/shrink now [focus]` does the same from the mod's own command and runs `/compact` once the session is idle.

**Subagents** keep Claude Code's built-in compaction; only the main session is shrunk.

## What you see

- **A bar above the prompt:** how full the context is against the shrink point, how many shrinks ran (and
  whether Haiku wrote them) and how many recalls answered.
- **`/shrink`:** opens a panel with every shrink (time, automatic or manual, context before → after, Haiku
  tokens, seconds, handoff file) and every recall (question, outcome, tries). It never opens on its own.
- **After a shrink**, Claude Code shows its usual "Compacted chat" line. The message under it starts with
  `# Handoff (this conversation was shrunk by the shrink mod)`, which is how you know the mod handled it.

## Configuration

Claude Code shows these options when you install the mod; the defaults work. To see or change them later,
use the `/config` menu (each option is a row there) or `claude plugin configure shrink` from a shell.

| Option | Default | Meaning |
|---|---|---|
| `mode` | `haiku` | `haiku`: Haiku writes the state of work. `code`: no model call at all at a shrink (facts only). |
| `shrinkModel` | `haiku` | Model alias or id for the state of work and for recall answers. |
| `handoffDir` | *(empty)* | Where handoffs, archives and the index go. Empty: `handoffs/` next to the session transcript. |
| `haikuBudgetTokens` | `80000` | Most input tokens one Haiku call may take (estimated at 2 chars per token). Larger shrinks are split. Keep it under 100000, where Haiku's price rises. |
| `digestChars` | `0` | Off by default. Set it to cap the digest in characters anyway; older lines go first. |
| `stateEffort` | `medium` | Reasoning effort for the state of work (`low`, `medium`, `high`, `xhigh`). |
| `mapEffort` | `medium` | Reasoning effort for the notes on each part of a split shrink. |
| `recallEffort` | `medium` | Reasoning effort for recall answers. |
| `factsBudgetChars` | `14000` | Size limit of the exact facts in the handoff. |
| `tailChars` | `24000` | Size limit of the messages kept word for word. |
| `recallScope` | `project` | `session`: recall searches this session only. `project`: also this project's other sessions. |
| `thresholdWarnAbove` | `200000` | Notice at session start when the auto-compact threshold is missing or above this. |

## Files it writes

Everything stays on your machine, in `~/.claude/projects/<project>/handoffs/` (or `handoffDir`):

| File | What |
|---|---|
| `session-handoff_<date>_<session>-<n>.md` | the handoff each shrink installed |
| `archive/<date>_<session>-<n>.txt` | the compacted conversation, one line per message (greppable) |
| `index/*.jsonl` | the search index recall uses |

It writes no logs or usage data. `claude --debug` shows one trace line per shrink and recall.

The only model calls are the Haiku calls, made through Claude Code's own model access like any other request.

## Limits

- **Facts that appear only in tool output can be missing from the summary.** The digest drops tool output to
  stay small. Recall still finds them, but only if Claude asks.
- **Recall helps only when Claude uses it.** The handoff tells Claude to call `recall` before guessing about
  anything from before a shrink.
- **Search matches whole words** (with light stemming), not parts of words: "pdf" does not find `fpdf2`.
  Leads with exact names (`fpdf2`, a file path, an error class) help.
- **The number check is strict.** An answer that mentions a number found neither in its quotes nor in the
  question fails the check, and after one retry recall returns raw passages, not a guessed number. Evidence
  labels, list numbering and digits inside names (`A7`, `J412`) are not counted as numbers.
- **Subagents keep the built-in compaction.**

## Uninstall

```sh
claude plugin uninstall shrink@recontext
claude plugin marketplace remove recontext   # optional
```

Built-in compaction takes over again at once. The `handoffs/` folders stay until you delete them.

## Development

```sh
git clone https://github.com/landtml/recontext
cd recontext
claude --plugin-dir .          # run Claude Code with the mod loaded from this folder (edits reload live)
claude plugin test .           # unit and hook tests
claude plugin validate .       # manifest, marketplace file and hooks module
npx -p typescript tsc -p .     # type-check (needs .claude-plugin/types/, written when Claude Code loads the mod)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and the rules the code keeps.

## Credits

The retrieval and answer checks (reciprocal rank fusion, evidence expansion, the reader prompt and the citation
gates) are adapted from [governed-rag](https://github.com/landtml/governed-rag).

## License

[MIT](LICENSE)
