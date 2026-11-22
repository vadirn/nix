#!/usr/bin/env python3
"""Dry run for `hooky`: replay real hook events through a built hooky binary and
check it reaches the decisions today's hooks reach when run directly.

For each event the harness:

1. runs hooky against its handler list (`home/claude/hooky/hooks.json`);
2. runs every matching handler alone on the same payload, as Claude Code does,
   and combines their answers by Claude Code's documented rules
   (deny > defer > ask > allow; exit 2 denies with stderr; every
   additionalContext reaches Claude);
3. compares the two: decision, deny reasons, updatedInput, added context, and
   for SessionStart and CwdChanged the CLAUDE_ENV_FILE the handlers wrote.

The matcher and combination rules here are written apart from hooky's Rust, so
a shared misreading of the docs is the one blind spot they keep.

No side effects outside a scratch directory:

- a scratch state.json switches off every handler whose command names
  trinket, turn-check, stop-verify or sound.sh, since those keep state, call an
  LLM, run a project's verify chain, or play audio;
- hooky logs to the scratch directory, and CLAUDE_ENV_FILE points there.

The guards only read their payload: none of them runs the command it inspects.

Corpus: PreToolUse calls to the guarded tools and PostToolUse Write/Edit calls
from the most recent transcripts under ~/.claude/projects. Sample: every call a
hook denied, plus up to --per-tool others per tool, drawn with random.seed(7).
A call counts as denied when its tool_result opens `PreToolUse:<tool> hook
error`; that recorded outcome is reported for information only, since scripts
changed since the call was made.

Usage: scripts/hooky-dryrun.py HOOKY_BIN [--files N] [--per-tool N] [--out DIR]
"""

import argparse
import concurrent.futures
import glob
import json
import os
import random
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.join(ROOT, "home/claude/settings.json")
HOOKS = os.path.join(ROOT, "home/claude/hooky/hooks.json")
SKIP = ("trinket", "turn-check", "stop-verify", "sound.sh")
PRE_TOOLS = ("Bash", "Read", "Grep", "WebSearch", "WebFetch", "mcp__visualize__show_widget")
RANK = {"allow": 1, "ask": 2, "defer": 3, "deny": 4}
MATCH_FIELD = {
    "PreToolUse": "tool_name",
    "PostToolUse": "tool_name",
    "PostToolUseFailure": "tool_name",
    "SessionStart": "source",
    "SessionEnd": "reason",
    "Notification": "notification_type",
}
DEFAULT_TIMEOUT = {"UserPromptSubmit": 30, "SessionEnd": 1.5}


def matches(matcher, value):
    """Claude Code's matcher rules: match-all, exact list, unanchored regex."""
    if matcher in ("", "*"):
        return True
    if re.fullmatch(r"[A-Za-z0-9_|, -]+", matcher):
        names = [n.strip() for n in re.split(r"[|,]", matcher) if n.strip()]
        return value in names
    return re.search(matcher, value) is not None


def handlers_for(hooks, event, payload, disabled):
    field = MATCH_FIELD.get(event)
    target = payload.get(field, "") if field else None
    chosen, seen = [], set()
    for group in hooks.get(event, []):
        matcher = group.get("matcher", "")
        if target is not None and not matches(matcher, target):
            continue
        for h in group["hooks"]:
            key = (event, matcher, h["command"])
            if key in disabled or (h["command"], h.get("async", False)) in seen:
                continue
            seen.add((h["command"], h.get("async", False)))
            chosen.append(h)
    return chosen


def run(cmd, payload_bytes, cwd, env, timeout):
    try:
        p = subprocess.run(
            cmd, input=payload_bytes, capture_output=True, cwd=cwd, env=env, timeout=timeout
        )
        return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return None, "", "timed out"


def parse_json(stdout):
    t = stdout.strip()
    if t.startswith("{") and t.endswith("}"):
        try:
            v = json.loads(t)
            return v if isinstance(v, dict) else None
        except ValueError:
            return None
    return None


def expected_from_direct(event, results):
    """Combines separate hook results the way Claude Code does."""
    decision, reasons, rewrites, context, blocks = None, [], [], [], []
    per = []
    for code, out, err in results:
        obj = parse_json(out)
        d, r = None, ""
        if obj is not None:
            hso = obj.get("hookSpecificOutput") or {}
            d = hso.get("permissionDecision")
            r = hso.get("permissionDecisionReason", "")
            if "updatedInput" in hso and code != 2:
                rewrites.append(hso["updatedInput"])
            if isinstance(hso.get("additionalContext"), str):
                context.append(hso["additionalContext"])
            if obj.get("decision") == "block":
                blocks.append(obj.get("reason", ""))
        if code == 2:
            if event == "PreToolUse":
                d, r = "deny", (r if d == "deny" else err.rstrip())
            else:
                blocks.append(err.rstrip())
        if code == 0 and obj is None and out.strip() and event in ("SessionStart", "UserPromptSubmit"):
            context.append(out)
        per.append((d, r))
        if d in RANK and (decision is None or RANK[d] > RANK[decision]):
            decision = d
    if decision:
        reasons = [r for d, r in per if d == decision and r.strip()]
    return {
        "decision": decision or ("block" if blocks else None),
        "reasons": reasons or [b for b in blocks if b.strip()],
        "updatedInput": None if decision == "deny" or not rewrites else rewrites[0],
        # hooky trims each part before joining; a lone passthrough keeps its
        # trailing newline, so the comparison below ignores trailing space.
        "context": "\n\n".join(c.rstrip() for c in context if c.strip()) or None,
    }


def interpret_hooky(event, code, out, err):
    obj = parse_json(out) or {}
    hso = obj.get("hookSpecificOutput") or {}
    decision = hso.get("permissionDecision")
    reasons = hso.get("permissionDecisionReason", "")
    if code == 2 and event == "PreToolUse":
        decision, reasons = "deny", reasons or err.rstrip()
    if obj.get("decision") == "block" or (code == 2 and event != "PreToolUse"):
        decision, reasons = "block", obj.get("reason") or err.rstrip()
    context = hso.get("additionalContext")
    if code == 0 and not obj and out.strip() and event in ("SessionStart", "UserPromptSubmit"):
        context = out
    return {
        "decision": decision,
        "reasons": reasons,
        "updatedInput": hso.get("updatedInput"),
        "context": context,
    }


def tool_result_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict))
    return ""


def mine(files, per_tool):
    calls, denied_ids = {}, {}
    for path in files:
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"tool_use"' not in line and '"tool_result"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                msg = rec.get("message") or {}
                content = msg.get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use" and block.get("name") in PRE_TOOLS + ("Write", "Edit"):
                        calls[block["id"]] = {
                            "tool": block["name"],
                            "input": block.get("input") or {},
                            "cwd": rec.get("cwd") or "",
                        }
                    elif block.get("type") == "tool_result":
                        text = tool_result_text(block.get("content"))
                        m = re.match(r"PreToolUse:(\S+) hook error", text)
                        if m:
                            denied_ids[block.get("tool_use_id")] = text[:200]
    rng = random.Random(7)
    by_tool = {}
    for cid, c in calls.items():
        c["recorded_denied"] = cid in denied_ids
        by_tool.setdefault(c["tool"], []).append(c)
    chosen = []
    for tool, items in sorted(by_tool.items()):
        denied = [c for c in items if c["recorded_denied"]]
        allowed = [c for c in items if not c["recorded_denied"]]
        rng.shuffle(allowed)
        chosen += denied + allowed[:per_tool]
    return chosen


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("hooky")
    ap.add_argument("--files", type=int, default=400, help="most recent transcripts to mine")
    ap.add_argument("--per-tool", type=int, default=40, help="allowed calls sampled per tool")
    ap.add_argument("--out", default=None, help="scratch directory (default: a new temp dir)")
    args = ap.parse_args()

    hooky = os.path.abspath(args.hooky)
    out_dir = args.out or tempfile.mkdtemp(prefix="hooky-dryrun-")
    os.makedirs(out_dir, exist_ok=True)
    hooks = json.load(open(HOOKS))["hooks"]
    # Before the switch, settings.json still lists the handlers itself, and the
    # two lists must agree. After it, settings.json holds only hooky entries.
    live = json.load(open(SETTINGS)).get("hooks", {})
    switched = any(
        re.search(r"(^|/)hooky [A-Z]", h.get("command", ""))
        for groups in live.values()
        for g in groups
        for h in g.get("hooks", [])
    )
    if not switched and live != hooks:
        print("hooks.json has drifted from settings.json's hooks block", file=sys.stderr)
        sys.exit(1)

    disabled = set()
    for event, groups in hooks.items():
        for g in groups:
            for h in g["hooks"]:
                if any(s in h["command"] for s in SKIP):
                    disabled.add((event, g.get("matcher", ""), h["command"]))
    state_path = os.path.join(out_dir, "state.json")
    json.dump(
        {"disabled": [{"event": e, "matcher": m, "command": c} for e, m, c in sorted(disabled)]},
        open(state_path, "w"),
    )

    files = sorted(
        glob.glob(os.path.expanduser("~/.claude/projects/**/*.jsonl"), recursive=True),
        key=lambda p: os.path.getmtime(p),
        reverse=True,
    )[: args.files]
    corpus = mine(files, args.per_tool)

    events = []
    for c in corpus:
        event = "PostToolUse" if c["tool"] in ("Write", "Edit") else "PreToolUse"
        events.append(
            (
                {
                    "session_id": "hooky-dryrun",
                    "cwd": c["cwd"],
                    "hook_event_name": event,
                    "tool_name": c["tool"],
                    "tool_input": c["input"],
                },
                c["recorded_denied"],
            )
        )
    # Events whose handlers write CLAUDE_ENV_FILE, from a directory with no
    # .envrc so direnv exports nothing and evaluates no project shell.
    plain_dir = os.path.join(out_dir, "plain-cwd")
    os.makedirs(plain_dir, exist_ok=True)
    for event, extra in (("SessionStart", {"source": "startup"}), ("CwdChanged", {})):
        events.append(({"session_id": "hooky-dryrun", "cwd": plain_dir, "hook_event_name": event, **extra}, None))
    # Events whose every handler is switched off here: hooky must say nothing.
    for event in ("Stop", "UserPromptSubmit", "SessionEnd", "StopFailure", "Notification", "TaskCompleted"):
        events.append(({"session_id": "hooky-dryrun", "cwd": plain_dir, "hook_event_name": event, "prompt": "hi"}, None))

    def check(i, item):
        payload, recorded = item
        event = payload["hook_event_name"]
        cwd = payload["cwd"] if os.path.isdir(payload["cwd"]) else plain_dir
        data = json.dumps(payload).encode()
        base = dict(os.environ, CLAUDE_PROJECT_DIR=cwd)

        def env_for(tag):
            env = dict(base)
            if event in ("SessionStart", "CwdChanged"):
                env["CLAUDE_ENV_FILE"] = os.path.join(out_dir, "env-%d-%s" % (i, tag))
                open(env["CLAUDE_ENV_FILE"], "w").close()
            return env

        renv = env_for("hooky")
        code, rout, rerr = run(
            [hooky, "--config", HOOKS, "--state", state_path, "--log-dir", os.path.join(out_dir, "log"), event],
            data,
            cwd,
            renv,
            700,
        )
        got = interpret_hooky(event, code, rout, rerr)
        denv = env_for("direct")
        direct = [
            run(["bash", "-c", h["command"]], data, cwd, denv, h.get("timeout", DEFAULT_TIMEOUT.get(event, 600)))
            for h in handlers_for(hooks, event, payload, disabled)
            if not h.get("async")
        ]
        want = expected_from_direct(event, direct)
        want_reasons = "\n".join(want["reasons"]) if want["reasons"] else ""
        diffs = []
        if got["decision"] != want["decision"]:
            diffs.append("decision hooky=%s direct=%s" % (got["decision"], want["decision"]))
        if (got["reasons"] or "") != want_reasons:
            diffs.append("reasons differ")
        if got["updatedInput"] != want["updatedInput"]:
            diffs.append("updatedInput differs")
        if (got["context"] or "").rstrip() != (want["context"] or ""):
            diffs.append("context differs")
        if code not in (0, 2) and not direct:
            diffs.append("hooky exited %s with nothing to run: %s" % (code, rerr.strip()))
        if event in ("SessionStart", "CwdChanged"):
            texts = []
            for tag, env in (("hooky", renv), ("direct", denv)):
                f = env["CLAUDE_ENV_FILE"]
                # Claude Code runs these handlers in parallel too, so the order
                # of their appended lines is not part of the answer.
                texts.append(sorted(open(f).read().replace(f, "<ENV_FILE>").splitlines()))
            if texts[0] != texts[1]:
                diffs.append("CLAUDE_ENV_FILE differs")
        return {
            "event": event,
            "tool": payload.get("tool_name"),
            "input": json.dumps(payload.get("tool_input"))[:160] if "tool_input" in payload else None,
            "hooky_exit": code,
            "hooky": got,
            "direct": want,
            "handlers": len(direct),
            "recorded_denied": recorded,
            "diffs": diffs,
        }

    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        results = list(pool.map(lambda iv: check(*iv), enumerate(events)))

    report = os.path.join(out_dir, "report.json")
    json.dump(results, open(report, "w"), indent=1)
    rows = {}
    for r in results:
        key = (r["event"], r["tool"] or "-")
        row = rows.setdefault(key, {"n": 0, "agree": 0, "deny": 0, "rewrite": 0, "context": 0, "recorded_deny": 0})
        row["n"] += 1
        row["agree"] += not r["diffs"]
        row["deny"] += r["hooky"]["decision"] == "deny"
        row["rewrite"] += r["hooky"]["updatedInput"] is not None
        row["context"] += bool(r["hooky"]["context"])
        row["recorded_deny"] += bool(r["recorded_denied"])
    print("| Event | Tool | Events | Agree | Hooky denies | Rewrites | Context | Recorded denials |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for (event, tool), row in sorted(rows.items()):
        print(
            "| %s | %s | %d | %d | %d | %d | %d | %d |"
            % (event, tool, row["n"], row["agree"], row["deny"], row["rewrite"], row["context"], row["recorded_deny"])
        )
    mismatches = [r for r in results if r["diffs"]]
    total = len(results)
    print("\n%d events, %d agree, %d differ. Report: %s" % (total, total - len(mismatches), len(mismatches), report))
    for r in mismatches[:20]:
        print("- %s %s %s: %s" % (r["event"], r["tool"], r["input"], "; ".join(r["diffs"])))
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
