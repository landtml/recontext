"""Turn a slice of a Claude Code transcript (.jsonl) into a SessionMessage[] test fixture.

Read-only over the transcript (opened for reading, never written). Writes one .ts file.

Usage:
  python3 tools/fixture.py <transcript.jsonl> --start N --count M --out fixtures/local-x.ts   # fixtures/local-* is git-ignored
  python3 tools/fixture.py <transcript.jsonl> --list            # list main-thread messages, one line each

The shape follows the mod API's SessionMessage (`$.session.messages()` / `session.compact`'s
`e.messages`): { role, text, toolUses: [{ tool_use_id, tool, input, text?, isError?, agentId? }],
toolResults?: [{ tool_use_id, text, isError }] }. Main thread only (no sidechains). The
transcript stores one row per content block; rows of one API message (same message.id) are
merged into one assistant message. Each tool use gets its outcome (`text`, `isError`) from
the tool_result that answers it, as the engine does once the transcript holds it.
"""
import argparse
import json
import sys


def block_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def load_messages(path):
    msgs = []
    last_asst_id = None
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("isSidechain") or r.get("type") not in ("user", "assistant"):
                continue
            m = r.get("message") or {}
            content = m.get("content")
            if r["type"] == "assistant":
                blocks = content if isinstance(content, list) else [{"type": "text", "text": content or ""}]
                if m.get("id") is not None and m.get("id") == last_asst_id and msgs and msgs[-1]["role"] == "assistant":
                    cur = msgs[-1]
                else:
                    cur = {"role": "assistant", "text": "", "toolUses": []}
                    msgs.append(cur)
                last_asst_id = m.get("id")
                for b in blocks:
                    if b.get("type") == "text" and b.get("text"):
                        cur["text"] = f"{cur['text']}\n{b['text']}" if cur["text"] else b["text"]
                    elif b.get("type") == "tool_use":
                        cur["toolUses"].append({"tool_use_id": b["id"], "tool": b["name"], "input": b.get("input") or {}})
                continue
            last_asst_id = None
            msg = {"role": "user", "text": block_text(content), "toolUses": []}
            results = []
            for b in content if isinstance(content, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    results.append({
                        "tool_use_id": b["tool_use_id"],
                        "text": block_text(b.get("content")),
                        "isError": bool(b.get("is_error")),
                        "_agentId": (r.get("toolUseResult") or {}).get("agentId")
                        if isinstance(r.get("toolUseResult"), dict) else None,
                    })
            if results:
                msg["toolResults"] = results
            msgs.append(msg)

    # the engine attaches each call's outcome to the tool use
    by_id = {}
    for m in msgs:
        for r in m.get("toolResults", []):
            by_id[r["tool_use_id"]] = r
    for m in msgs:
        for u in m["toolUses"]:
            r = by_id.get(u["tool_use_id"])
            if r is None:
                continue
            u["text"] = r["text"]
            if r["isError"]:
                u["isError"] = True
            if u["tool"] == "Agent" and r.get("_agentId"):
                u["agentId"] = r["_agentId"]
    for m in msgs:
        for r in m.get("toolResults", []):
            r.pop("_agentId", None)
    return msgs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("transcript")
    ap.add_argument("--start", type=int, default=0, help="index of the first main-thread message")
    ap.add_argument("--count", type=int, default=60, help="how many messages")
    ap.add_argument("--out", help="the .ts file to write")
    ap.add_argument("--name", default="messages", help="the exported constant's name")
    ap.add_argument("--list", action="store_true", help="list the messages instead of writing")
    a = ap.parse_args()

    msgs = load_messages(a.transcript)
    if a.list:
        for i, m in enumerate(msgs):
            tools = ",".join(u["tool"] + ("!" if u.get("isError") else "") for u in m["toolUses"])
            res = len(m.get("toolResults", []))
            print(f"{i:5d} {m['role'][:4]} tools[{tools}] results={res} | {m['text'][:70]!r}")
        return
    if not a.out:
        sys.exit("--out is required unless --list")
    part = msgs[a.start:a.start + a.count]
    header = (
        "// Generated by tools/fixture.py from a real transcript; do not edit by hand.\n"
        f"// Source: {a.transcript.rsplit('/', 1)[-1]}, main-thread messages {a.start}..{a.start + len(part) - 1}"
        f" ({len(part)} of {len(msgs)}).\n"
        "import type { SessionMessage } from 'claude-code'\n\n"
    )
    body = json.dumps(part, ensure_ascii=False, indent=1)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(f"{header}export const {a.name}: SessionMessage[] = {body}\n")
    print(f"wrote {a.out}: {len(part)} messages")


if __name__ == "__main__":
    main()
