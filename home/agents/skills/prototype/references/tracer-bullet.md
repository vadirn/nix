# Tracer bullet and walking skeleton workflow (retained)

Use when the intent is retained: the prototype is the first commit of production. Sources: Hunt & Thomas, _The Pragmatic Programmer_ (1999), tracer bullets chapter; Cockburn, _Crystal Clear_ (2004), walking skeleton.

The two methods share a workflow. They differ only in scope:

- **Tracer bullet.** A single end-to-end path through one feature. Lean but complete: real database, real API, real auth, no mocks at the seams. The bullet exists to verify the design under realistic load before the rest of the system follows.
- **Walking skeleton.** End-to-end slice that touches every architectural layer (UI, application service, domain, persistence, integration), even if each layer does the trivial thing. The skeleton exists to verify the layers talk to each other.

Pick the tracer bullet for a single-feature prototype with clear functional goals. Pick the walking skeleton for a new system or new architecture where layer integration is the open question.

## Production qualities from line one

This is the rule that separates retained from throwaway. Set these up before any feature code:

- **Tests.** At least one end-to-end test that exercises the slice. Add unit tests as soon as logic warrants them.
- **Error handling.** Real failures at every seam: network errors, validation errors, auth failures, timeouts. No `panic` / unwrap / silent catch.
- **Observability.** Structured logs, request IDs, a metric or two. The slice should be debuggable in production from day one.
- **Security baseline.** Authentication on every endpoint. Authorization rules written and tested. Input validation on every boundary. If a database is involved, Row-Level Security or equivalent (see SKILL.md gotchas).
- **Configuration.** Secrets out of code, environment-driven config, sensible defaults.
- **CI.** Tests run on every commit. Build artifacts are produced. The slice is deployable.

If any of these is skipped, the code is a spike with a misleading label. Re-classify as throwaway and use `references/spike.md`.

## Build the thinnest slice

The goal is a working end-to-end path, not a complete feature.

- One user can do one thing, all the way through, from request to response.
- Every layer is real. No mocks, no fakes, no fixtures at the seams.
- Behaviour is narrow: one input shape, one output shape, one happy path, one error path.

Resist scope creep. If a second use case appears, write it down as a follow-up. The slice answers "do the pieces fit together"; it does not answer "is the feature done".

## Capture

The capture artifact for retained prototypes is an ADR (Architecture Decision Record). Open `references/capture-templates.md` and use the Nygard template:

- **Context.** The forces in play. What problem the system faces. What constraints apply (regulatory, performance, team, deadline).
- **Decision.** The position taken, active voice: "We will…". One paragraph. The decision is the thesis; everything else is grounds.
- **Status.** `proposed` while in review, `accepted` after sign-off, `superseded by NNNN` when a later ADR replaces it.
- **Consequences.** What becomes easier. What becomes harder. What becomes impossible. The tradeoffs accepted. List the second-order effects you can name; the unnamed ones will surface later.

After drafting, apply each check in `references/capture-checks.md`. Record the filled-in templates in the ADR so the reasoning is visible to future readers. The ADR-specific Consequences rule (at least one negative effect) lives in `references/capture-templates.md`.

File the ADR at `docs/adr/<NNNN>-<slug>.md` where `<NNNN>` is the next four-digit serial in that directory.

## Hand off

After the ADR is filed, the prototype is done. The slice becomes the seed of the feature; subsequent work expands it via ordinary engineering: more cases, more layers, more tests, driven by whichever development loop the project uses.

The skill stops here. Hand off to the team's normal development process; ongoing development is feature work, not prototype work.
