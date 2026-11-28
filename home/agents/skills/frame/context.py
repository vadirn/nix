"""Read the active chat's probe subject and its same-subject history."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=("codex", "claude"))
    parser.add_argument("--session")
    args = parser.parse_args()
    identities = [(host, os.environ[var]) for host, var in
                  (("codex", "CODEX_THREAD_ID"), ("claude", "CLAUDE_CODE_SESSION_ID"))
                  if os.environ.get(var)]
    if args.host and args.session:
        identity = (args.host, args.session)
    elif not args.host and not args.session and len(identities) == 1:
        identity = identities[0]
    else:
        parser.error("provide both --host and --session for the current chat")
    default_db = Path.home() / "Library/Application Support/Trinket/runs.sqlite"
    path = Path(os.environ.get("DB_PATH", default_db)).resolve()
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        rows = db.execute("""
            SELECT r.id, a.body FROM prompt_rounds p JOIN runs r ON r.id=p.run_id
            JOIN artifacts a ON a.run_id=r.id AND a.kind='decision'
            WHERE p.conversation=? AND r.pipeline IN ('prompt.ask', 'prompt.probe') AND r.status='finished'
            ORDER BY r.id DESC, a.id DESC
        """, ("/".join(identity),))
        history = []
        for run, body in rows:
            decision = json.loads(body)
            if not history:
                subject, latest = decision["targetRef"], run
            if decision["targetRef"] == subject:
                history.append({"run": run, "decision": decision})
        if not history:
            print("No completed probe for this chat.", file=sys.stderr)
            return 4
        dialogue = json.loads(db.execute("""
            SELECT body FROM artifacts WHERE run_id=? AND kind='dialogue'
            ORDER BY id DESC LIMIT 1
        """, (latest,)).fetchone()[0])
        messages = dialogue["messages"]
        target = next((m for m in messages if m["ref"] == subject), None)
        if target is None:
            raise ValueError("probe subject missing from saved dialogue")
        print(json.dumps({"probeRun": latest, "target": target,
                          "messages": messages, "rounds": history[::-1]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
