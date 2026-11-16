---
name: comms
description: >
  Apply and monitor the personal communication guide. Draft one message by the guide's rules from a
  thread or a binding, sweep Slack and Basecamp for messages owed, or run the monthly review. Drafts
  and reports only, never sends. Triggers: /comms, "draft a reply to this thread", "draft a heartbeat",
  "draft my check-in", "draft a status update for <name>", "how do I answer this complaint", "what do
  I owe", "sweep my comms", "comms review". Route elsewhere: any other Basecamp action → /basecamp;
  restyling prose → /simplify-text.
---

# Comms

This skill applies the communication guide. It holds no rules of its own.

- The rules live in the vault note `Communication guide`.
- The bindings live in each project's `Context.md`.
- The sweep reads the YAML block under "Bindings as data".

Never send, post, or publish. Every command ends in a draft or a report in this conversation. The user sends.

- Run only read commands against Basecamp. Never run `basecamp checkins answer create` or `update`.
- Read Slack only. Never call a Slack tool that sends, schedules, or saves a draft.

```
dir = skill base directory
guide = Read(Bash(vault-query get "Communication guide"))
em_context = "/Users/vadim/Documents/vault/41 projects/evil-martians/Context.md"

if guide or em_context is missing: stop, and report which one

if "draft <thread or binding>":
    binding = find the binding in em_context or the project's Context.md
    thread = read the thread or channel the user named
    branch = the guide's test: do the reader's decisions depend on this message?
    if branch A: gap = name the gap by the guide's Branch A principles: impression or target
        if the thread does not settle which: ask the user before drafting, and say that a report cannot close a target gap
    template = Read(dir/templates/<heartbeat | weekly-status | check-in | renegotiation>.md)
    if the template is weekly-status and the thread lacks the facts:
        Read(dir/references/evidence.md), and gather by its procedure
    draft = fill the template by the guide's rules for that branch
    check the draft: R1 reader and purpose, R3 reader's currency, A3 time of the next update
    show the draft and name each rule it applies

elif "sweep" or "sweep <binding id>":
    data = the YAML block in em_context
    since = the last 7 days, or the range the user gave
    for each binding in data:
        for each slack_channel source: read the channel since `since`, and read each thread the user is in
        for each basecamp_checkin source:
            Bash(basecamp checkins answers <question> --in <bucket> --by me --limit 5 --json)
        run each check the binding lists
    report = one table: binding, check, finding, link, age
    for each finding: offer a draft, using "draft"
    if data.as_of is older than one month: say that the bindings are stale

elif "review":
    run the guide's Upkeep section, one step at a time
    count for Branch A: requests answered the same working day, and updates that name the next one
    count for Branch B: clock pieces published against clock pieces called for
    list each binding field older than one month
    report the counts and the stale fields; the user edits the guide and the bindings
```

## Checks

- **unanswered_request:** someone asked the user something, and the user gave no reply the same working day. A reply needs a deadline or a result (A2). A bare reaction does not count.
- **overdue_promise:** the user named a time for the next update or a deadline (A1, A3), and that time passed with no message.
- **missing_checkin:** the last Friday passed with no answer from the user to the check-in question (A4, B8).

A working day follows Asia/Almaty time, Monday to Friday.

Skip any day on which a bot message in the channel says the user has a day off. Do not state the reason for the day off.

## Report shape

Lead with the count of findings. Then give the table. Then give one draft per finding. When nothing is owed, say so in one line.

Mark what the sweep could not see: calls, direct messages it did not read, and any source that failed.

## Neighbours

- **/basecamp** holds the full CLI reference. Read it when a `basecamp` command here fails.
- **The `comms-sweep` scheduled task** runs the same sweep each workday. It carries its own copy of the steps and checks. Change both when a check changes.
