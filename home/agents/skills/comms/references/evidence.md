# Evidence for a weekly status

Use it when a weekly status needs more than the thread holds. It gathers facts from work artifacts. It adds no communication rule: the guide and the template decide what the message says.

## Why each field carries a tag

No artifact holds the lines that matter most: blocked, risk, confidence, and next. Git cannot supply them. So each field carries one tag that says where it came from:

- **artifact:** read from git, a crux note, or the thread.
- **inferred:** a guess from commit cadence or a note. Mark it, and never state it as fact.
- **elicited:** the user supplies or confirms it.

The tags stop a draft from covering thin work with confident prose.

## Procedure

```
reader = the stakeholder the draft is for, from the binding
period = since the user's last status to this reader in the thread, else the last 7 days
       // --since <ref> overrides; always print the range, such as "Period: Jun 9–18"

commits = Bash(git log --since=<period> --stat)   // the repo that holds cwd, one repo only
notes   = the crux track for this work: decisions and observations in the period
weekly  = the vault weekly log for the ISO weeks in the period, if present

digest = one pass over thread, commits, notes, and weekly, with a tag on every field
show the digest once: the user confirms each [inferred] field and fills each [elicited] field in one reply
fill templates/weekly-status.md from the confirmed digest
```

## Digest

| Template line | Usual source |
| ------------- | ------------ |
| Done          | [artifact] from commits and the thread. Keep it to one line when the reader watches PRs. |
| Next          | [artifact] from a crux note, else [inferred]. |
| Blocked       | [artifact] when a note or the thread says so. Else [inferred] from a stall, else [elicited]. |
| Risk          | [inferred] or [elicited]. No artifact states risk. |
| Confidence    | [elicited], unless a note revised the estimate. |

For invisible work, the "Done" line makes a claim about future cost. Render it as `[claim: verify before sending]`.

## Say these out loud

- **Thin work:** when the period holds few artifacts, say so. An honest "quiet week" beats padded prose.
- **One repo:** work in another repository is out of view. Name it under what the draft could not see.
- **Stale binding:** show the reader's currency and tolerance as the binding states them, so the user can catch drift.
