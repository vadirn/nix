# Spike workflow (throwaway implementation)

Use when the design question is "does X work" and the intent is throwaway. Source: Beck, *Extreme Programming Explained* (1999).

A spike is investigation in code form. The code is evidence. The deliverable is the answer.

## Isolation

Before writing any code, separate the spike workspace from production code. The shape of the isolation depends on the time-box.

**Minutes to one hour.** Use `$TMPDIR/vibe-<slug>/` as the workspace. Skip the README, skip the branch, skip the build-ignore plumbing. The code never touches the repo. This is the cheap path: when the spike is over, the directory disappears with the next shell session.

**One hour to one day.** Use a scratch directory in the repo: `_spikes/<slug>/` at repo root, ignored by build and CI. Write a README header marking it `THROWAWAY` with a link to the design question. The README is the trip-wire that catches accidental promotion.

**Days.** Use a dedicated branch `spike/<slug>`, never merged, or a separate scratch repo when the spike pulls in dependencies you would not accept in production. The README rule still applies.

If the production stack constrains the answer (specific framework, specific runtime), match it. Otherwise pick the fastest stack for the question. Cheap-to-change languages let you test the technique without fighting the build system.

## Run

Execute the spike up to the time-box. Cut every corner that does not bear on the design question:

- Hard-code inputs the production system would derive.
- Skip error handling for paths the production system would cover; assert loudly on the happy path.
- Skip tests, except those that *are* the answer (a benchmark, a load test, a correctness check).
- Skip authorization, logging, telemetry, retries, configuration. The spike does not run in production.

If the spike requires touching a real database or external service, treat that as a constraint: set up the smallest possible isolated instance, always separate from the shared dev environment. See gotchas in SKILL.md for the Row-Level Security warning.

If a blocker appears (the technique requires something you cannot get inside the time-box), surface it immediately. Respect the time-box; record any extension in writing.

## Capture

When the question is answered or the time-box expires, the spike code stops being interesting. The memo is the deliverable.

Open `references/capture-templates.md` and write a Decision memo:

- **Question.** Verbatim from D1.
- **Method.** What was built. Time actually spent. Any cut corners worth noting.
- **Result.** What happened. Numbers if any. Quote logs or screenshots if they carry the evidence.
- **Decision.** Proceed / abandon / revise. One sentence. Tie it to the question.
- **Next step.** One concrete action. See `references/next-steps.md`.

After drafting, apply each check in `references/capture-checks.md`. Record the filled-in templates in the memo so the reasoning is visible to future readers.

File the memo at `docs/spikes/<YYYY-MM-DD>-<slug>.md`.

## Disposal

The spike code is now overhead. Ask the user:

- Archive: tag the branch (`spike/<slug>-archived`) and delete the working copy. Useful if a future spike might revisit the same question.
- Delete: drop the branch or directory. Default for cheap-to-reproduce spikes.

Keep spike code out of production. If the answer is "yes, proceed", start the production implementation fresh from the design (informed by the spike, not built on it). Promotion is the failure mode named in SKILL.md gotchas.
