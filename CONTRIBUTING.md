# Contributing

## Layout

The repository root is the mod (a Claude Code plugin made of one hooks module) and its own marketplace.

```
.claude-plugin/plugin.json        manifest: name "shrink", version, options (userConfig)
.claude-plugin/marketplace.json   makes this repository installable with /plugin install
hooks/hooks.json                  { "modules": ["./register.ts"] }
hooks/register.ts                 the hooks and engine calls only: compaction, recall tool, bar, /shrink
hooks/units.ts search.ts digest.ts handoff.ts reader.ts facts.ts archive.ts prompt.ts view.ts
                                  pure functions, each with a *.test.ts
hooks/ui.tsx                      the bar above the prompt and the /shrink panel
types/index.d.ts                  the mod's session state contract ($.state)
fixtures/sample-session.ts        an invented 72-message session the tests run on
fixtures/golden.ts                retrieval questions over that session, with the units that answer them
tools/fixture.py                  turn a slice of your own transcript into a local fixture
docs/design.md                    the design
```

## Rules the code keeps

- **The mod can never make a compaction fail.** Every error path ends in the code-only handoff or in Claude
  Code's own compaction (`next(e)`).
- **Pure functions stay pure** and keep their unit tests; `register.ts` holds only hooks and `$` calls.
- **Recall never states what the archive does not say:** answers carry quotes that code checks, or the tool says
  "not found" or returns raw passages marked unverified.
- **At runtime the mod writes only in its handoff folder.**

## Checks

Run all three before a pull request:

```sh
claude plugin test .
claude plugin validate .
npx -p typescript tsc -p .
```

`tsc` needs `.claude-plugin/types/`, which Claude Code writes when it loads the mod (start `claude --plugin-dir .`
once). The folder is git-ignored.

## Fixtures from your own sessions

`tools/fixture.py` reads a transcript (`~/.claude/projects/<project>/<session>.jsonl`, read-only) and writes a
`SessionMessage[]` fixture. Write it to `fixtures/local-<name>.ts`: that pattern is git-ignored, because a real
transcript holds your conversation, paths and possibly secrets. Do not commit real transcripts; the shared tests
use the invented `fixtures/sample-session.ts`.
