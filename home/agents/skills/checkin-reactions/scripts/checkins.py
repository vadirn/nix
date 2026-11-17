#!/usr/bin/env python3
"""Check-in reactions: fetch Basecamp check-ins since my last answer, build the
picker page, and post the reactions I picked.

Subcommands (run with python3 -I):
  fetch  --out DIR                      answers after my latest one, with reactions and comments
  build  --data DIR --topics FILE --out FILE
  check  --data DIR --picks FILE --out PLAN
  apply  --plan PLAN [--dry-run]        posts one, verifies it, then posts the rest
  verify --plan PLAN                    confirms each planned reaction exists under my name

Every Basecamp call goes through the `basecamp` CLI, so auth stays with the CLI.
"""

import argparse
import html
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_RUNES = 16  # Basecamp's boost limit
TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "page.tpl.html"


def bc(*args):
    """Run a basecamp CLI command in agent mode and return its JSON data."""
    proc = subprocess.run(["basecamp", *args, "--agent"], capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"basecamp {' '.join(args)} failed ({proc.returncode}): {proc.stdout.strip() or proc.stderr.strip()}")
    return json.loads(proc.stdout)


def key(text):
    """Grouping key for a reaction: drop emoji style selectors and outer spaces."""
    return text.replace("️", "").strip()


def plain(content):
    text = re.sub(r"<bc-attachment[^>]*>.*?</bc-attachment>", " ", content or "", flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(html.unescape(text).replace(" ", " ").split())


def when(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()


def short_date(dt):
    return dt.strftime("%b ") + str(dt.day)


def me_id():
    return bc("people", "show", "me")["id"]


# ---------------------------------------------------------------- fetch

def cmd_fetch(a):
    me = me_id()
    answers, mine = [], None
    for limit in ("100", "500", None):
        answers = bc("checkins", "answers", "--all-projects", *(["--limit", limit] if limit else ["--all"]))
        mine = next((x for x in answers if x["creator"]["id"] == me), None)
        if mine:
            break
    if not mine:
        sys.exit("No check-in answer of yours found; nothing to compare against.")

    cutoff = mine["created_at"]
    newer = [x for x in answers if x["created_at"] > cutoff and x["creator"]["id"] != me]
    posts = []
    for x in newer:
        pid, bucket = str(x["id"]), str(x["bucket"]["id"])
        boosts = [{"c": b["content"], "by": b["booster"]["id"]} for b in bc("boost", "list", pid, "--in", bucket)]
        comments = []
        if x.get("comments_count"):
            for c in bc("comments", "list", pid, "--in", bucket, "--all"):
                comments.append({"author": c["creator"]["name"], "by": c["creator"]["id"],
                                 "created_at": c["created_at"], "url": c["app_url"], "text": plain(c["content"])})
        posts.append({"id": pid, "bucket_id": bucket, "author": x["creator"]["name"], "created_at": x["created_at"],
                      "group_on": x.get("group_on"), "url": x["app_url"], "question": x["parent"]["title"],
                      "excerpt": plain(x["content"])[:400], "boosts": boosts, "comments": comments})

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    data = {"me": me, "fetched_at": datetime.now(timezone.utc).isoformat(),
            "cutoff": {"id": str(mine["id"]), "created_at": cutoff, "url": mine["app_url"]}, "posts": posts}
    (out / "data.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))

    reacted = sum(1 for p in posts if any(b["by"] == me for b in p["boosts"]))
    print(f"My latest answer: {short_date(when(cutoff))} {mine['app_url']}")
    print(f"{len(posts)} newer answers; {reacted} already have my reaction; "
          f"{sum(len(p['comments']) for p in posts)} comments on {sum(1 for p in posts if p['comments'])} posts")
    print("\nOpenings for topic lines (id | author | first 400 characters):")
    for p in posts:
        print(f"{p['id']} | {p['author']} | {p['excerpt']}")


# ---------------------------------------------------------------- build

def cmd_build(a):
    data = json.loads((Path(a.data) / "data.json").read_text())
    topics = json.loads(Path(a.topics).read_text()) if a.topics else {}
    me = data["me"]
    rows, missing = [], []
    for p in data["posts"]:
        groups, order = {}, []
        for b in p["boosts"]:
            k = key(b["c"])
            if k not in groups:
                groups[k] = {"key": k, "raw": b["c"].strip(), "n": 0}
                order.append(k)
            groups[k]["n"] += 1
        reactions = sorted(groups.values(), key=lambda g: (-g["n"], order.index(g["key"])))
        topic = topics.get(p["id"])
        if not topic:
            missing.append(p["id"])
            topic = p["excerpt"][:140] + ("…" if len(p["excerpt"]) > 140 else "")
        rows.append({
            "id": p["id"], "author": p["author"], "date": short_date(when(p["created_at"])), "url": p["url"],
            "topic": topic, "reactions": reactions,
            "mine": [key(b["c"]) for b in p["boosts"] if b["by"] == me],
            "comments": [{"author": c["author"], "url": c["url"], "mine": c["by"] == me,
                          "text": c["text"][:220] + ("…" if len(c["text"]) > 220 else "")} for c in p["comments"]],
        })
    meta = {"since": short_date(when(data["cutoff"]["created_at"])), "asOf": short_date(when(data["fetched_at"]))}
    tpl = Path(a.template).read_text()
    for marker in ("/*__META__*/{}", "/*__DATA__*/[]"):
        if marker not in tpl:
            sys.exit(f"Template is missing {marker}")
    page = tpl.replace("/*__META__*/{}", json.dumps(meta, ensure_ascii=False)) \
              .replace("/*__DATA__*/[]", json.dumps(rows, ensure_ascii=False))
    Path(a.out).write_text(page)
    print(f"Built {a.out}: {len(rows)} posts, since {meta['since']}, as of {meta['asOf']}")
    if missing:
        print(f"No topic line for {len(missing)} posts, used the excerpt instead: {', '.join(missing)}")


# ---------------------------------------------------------------- check

def load_picks(path):
    """Accept {postId: reaction}, [{id, reaction}], or ArtifactData rows [{id, data: {reaction, status}}]."""
    raw = json.loads(Path(path).read_text())
    if isinstance(raw, dict):
        return {str(k): v for k, v in raw.items()}
    picks = {}
    for row in raw:
        body = row.get("data", row)
        if body.get("status", "queued") in ("queued", "failed"):
            picks[str(row["id"])] = body["reaction"]
    return picks


def cmd_check(a):
    data = json.loads((Path(a.data) / "data.json").read_text())
    posts = {p["id"]: p for p in data["posts"]}
    me = data["me"]
    plan, report = [], []
    for pid, reaction in load_picks(a.picks).items():
        reaction = " ".join(str(reaction).split())
        p = posts.get(pid)
        if not p:
            report.append((pid, reaction, "skip", "not in the current list"))
            continue
        n = len(reaction)
        if n == 0 or n > MAX_RUNES:
            report.append((pid, reaction, "skip", f"{n} characters; Basecamp allows 1–{MAX_RUNES}"))
            continue
        k = key(reaction)
        if any(b["by"] == me and key(b["c"]) == k for b in p["boosts"]):
            report.append((pid, reaction, "skip", "already posted"))
            continue
        custom = all(key(b["c"]) != k for b in p["boosts"])
        plan.append({"id": pid, "bucket_id": p["bucket_id"], "author": p["author"], "reaction": reaction, "custom": custom})
        report.append((pid, reaction, "custom" if custom else "ok", p["author"]))
    Path(a.out).write_text(json.dumps(plan, ensure_ascii=False, indent=1))
    for pid, reaction, status, note in report:
        print(f"{status:6} {pid} {reaction}  {note}")
    print(f"\n{len(plan)} to post ({sum(1 for x in plan if x['custom'])} custom); "
          f"{sum(1 for r in report if r[2] == 'skip')} skipped. Plan: {a.out}")


# ---------------------------------------------------------------- apply / verify

def mine_on(post_id, bucket, me, reaction):
    k = key(reaction)
    return [b["id"] for b in bc("boost", "list", post_id, "--in", bucket) if b["booster"]["id"] == me and key(b["content"]) == k]


def cmd_apply(a):
    plan = json.loads(Path(a.plan).read_text())
    if not plan:
        print("Nothing to post.")
        return
    me = me_id()
    results = []
    for i, item in enumerate(plan):
        if a.dry_run:
            print(f"would post {item['reaction']} on {item['id']} ({item['author']})")
            continue
        if mine_on(item["id"], item["bucket_id"], me, item["reaction"]):
            results.append({**item, "status": "posted", "note": "already there"})
            continue
        proc = subprocess.run(["basecamp", "boost", "create", item["id"], item["reaction"], "--in", item["bucket_id"], "--agent"],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            results.append({**item, "status": "failed", "note": (proc.stdout or proc.stderr).strip()[:300]})
            if i == 0:
                break
            continue
        boost = json.loads(proc.stdout)
        results.append({**item, "status": "posted", "boost_id": boost["id"]})
        if i == 0 and not mine_on(item["id"], item["bucket_id"], me, item["reaction"]):
            results[-1]["status"] = "failed"
            results[-1]["note"] = "posted but not found under my name; stopped"
            break
    if a.dry_run:
        return
    out = Path(a.plan).with_name("results.json")
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    for r in results:
        print(f"{r['status']:6} {r['id']} {r['reaction']}  {r.get('boost_id', r.get('note', ''))}")
    posted = sum(1 for r in results if r["status"] == "posted")
    print(f"\n{posted} posted, {len(results) - posted} failed, {len(plan) - len(results)} not attempted. Results: {out}")


def cmd_verify(a):
    plan = json.loads(Path(a.plan).read_text())
    me = me_id()
    bad = 0
    for item in plan:
        if not mine_on(item["id"], item["bucket_id"], me, item["reaction"]):
            bad += 1
            print(f"MISSING {item['id']} {item['reaction']} ({item['author']})")
    print(f"verified {len(plan) - bad} of {len(plan)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("fetch"); s.add_argument("--out", required=True); s.set_defaults(fn=cmd_fetch)
    s = sub.add_parser("build"); s.add_argument("--data", required=True); s.add_argument("--topics")
    s.add_argument("--template", default=str(TEMPLATE)); s.add_argument("--out", required=True); s.set_defaults(fn=cmd_build)
    s = sub.add_parser("check"); s.add_argument("--data", required=True); s.add_argument("--picks", required=True)
    s.add_argument("--out", required=True); s.set_defaults(fn=cmd_check)
    s = sub.add_parser("apply"); s.add_argument("--plan", required=True); s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_apply)
    s = sub.add_parser("verify"); s.add_argument("--plan", required=True); s.set_defaults(fn=cmd_verify)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
