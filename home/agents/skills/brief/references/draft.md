# draft — compose a per-stakeholder update

Goal: produce a status update that closes impression distance for one stakeholder, in their
currency, carrying the communication-only content no artifact holds — without fabricating any
of it. End at a draft in the terminal; never send.

## Why the seam exists

The six communication-only fields (in progress · blocked + why · at risk · revised estimate ·
next · counterfactual) are, by definition, the part **no artifact carries**. So you cannot
read them out of git. You can only do three things with each field, and you must be honest
about which:

- **artifact** — genuinely read from git/track (mostly the _shipped_ line and _in progress_).
- **inferred** — your guess from commit cadence or a track note. Pre-fill it, but **mark it** so the user knows to check it. Never assert an inferred field as fact.
- **elicited** — the user supplies or confirms it in the one review pass below.

This provenance is the laundering guard. Without it the model writes plausible relational prose
over thin work — proof-of-care with no proof-of-work, the failure the concept names. Marked
provenance means an unverified field stays visibly unverified instead of hardening into prose.

## Procedure

```
// Setup — see SKILL.md "Resolving the project": cfg, context, roster, repo.

// Recipients before period: the default period is per-recipient
recipients = do("choose recipient(s) — see Reference: Recipients")
period     = resolve_period(recipients, args)   // see Reference: Period; always print the range

// Gather, merged by date
commits = Bash(git -C <repo> log --since=<period> --stat)
track   = do("read the project's track-*.md: Decisions, Backlog, Log")
weekly  = do("read current + prior ISO-week weekly-log Activity, if present")

// ONE stakeholder-agnostic pass, then confirm
digest = do("build the digest, provenance per field — see Reference: Digest")
digest = do("one review pass: show provenance tags; user confirms [inferred] and fills
             [elicited] in a single reply — never interrogate field by field")

// Project, emit, never send
drafts = do("for each recipient, project the digest into their currency — see Reference: Projection")
do("emit the draft(s) using the template below, then stop")

if user accepts a draft:
    do("set that stakeholder's last_drafted = today in context.md frontmatter — see Reference: Watermark")
```

## Reference

### Recipients

- roster has 1 stakeholder → draft for that one.
- roster has >1 → one-line pick (list names + currency), or `--all` to fan out.
- no roster → draft a single generic update and offer to add a `stakeholders:` list to context.md.

### Period

Default = since the chosen stakeholder's `last_drafted`. `--all` → the earliest `last_drafted`
among the chosen (the widest window). No `last_drafted` (or no roster) → last 7 days. `--since
<ref>` overrides (git rev, date, "last monday"). Always print the resolved range, e.g.
"Period: Jun 9–18", so a wrong default is visible and correctable.

### Digest

ONE stakeholder-agnostic pass; attach provenance to each field. `context.md` gives durable
framing (what the project is for, who counts in what).

| field            | provenance                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------- |
| shipped          | inspection-closeable, ONE line, [artifact]                                                |
| in_progress      | [artifact] from open work / WIP commits                                                   |
| blocked_why      | [artifact] if a track note says so; else [inferred] from a stall; else blank → [elicited] |
| at_risk          | almost always [inferred] or [elicited] — no artifact states risk                          |
| revised_estimate | [elicited] unless a track note revised it                                                 |
| next             | [artifact] from Backlog/Direction; else [inferred]                                        |
| counterfactual   | for non-feature work; render as "[claim — verify before sending]"                         |

### Projection

For each recipient, surface their stored assumption first so staleness is visible:
"Drafting for Sarah: counts in features+dates, waits to be told. Stale? edit context.md".
When `--all` gathered a wider window, trim each draft to that stakeholder's own `last_drafted`.
Then translate the digest into their currency:

- drop inspection-closeable detail they already watch (if they inspect PRs, don't recap merges)
- render infra/exploration as its counterfactual in their currency, not in infra terms
- lead with what their model is missing, not with what shipped
- index to THEIR model and what THEY decide, not the person you usually talk to

### Watermark

On the user accepting a draft in-session ("good", "send it", "done"), advance that stakeholder's
`last_drafted` to today — a surgical edit to that entry in context.md frontmatter. This is brief's
ONLY write. It tracks "last accepted draft" (observable), not "last sent" (which the skill cannot
see). On heavy edits, advance only when done.

## Draft template

```
─────────────────────────────────────
For: <stakeholder> · Project: <name> · Period: <range>

Shipped: <one line — what they can already see>

In progress: <current focus, in their currency>

Blocked: <what + why, or "nothing blocking">

At risk: <risks, or "none surfaced"> [mark any inferred risk]

Revised estimate: <change + the driver, or "on track">

Next: <what comes next>

<counterfactual line, only for non-feature work, as: [claim — verify before sending]>
─────────────────────────────────────
DRAFT — not sent. Send it yourself. Sources: <repo/track/weekly seen>
```

## Failure modes to name out loud

- **Thin work → confident prose.** If the period's artifacts are sparse, say so; do not inflate. An honest "quiet week, here is the little there is" beats laundered substance.
- **Stale roster.** The Projection step surfaces the stored assumption precisely so the user can catch a drifted currency/model. Trust `context.md`, but show what you trusted.
