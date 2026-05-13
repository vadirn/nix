# Capture artifact templates

The prototype is not done until the capture artifact is filed. Pick the template by intent and question:

- **Decision memo** — throwaway findings of any kind.
- **ADR** — retained architectural decision.
- **Eval set** — LLM behavioural prototype, throwaway or retained.
- **RFC / RFD** — cross-team change requiring discussion before commit.

## Decision memo

For throwaway spike, Wizard of Oz, and prompt-as-prototype findings. File at `docs/spikes/<YYYY-MM-DD>-<slug>.md`.

```markdown
# <Design question, verbatim>

Date: <YYYY-MM-DD>
Status: <answered | inconclusive | abandoned>
Time-box: <stated> / <actual>

## Method

What was built, in one paragraph. Stack, scope, what was cut.

## Result

What happened. Numbers if any. Quotes, screenshots, or links to logs when those carry the evidence.

## Decision

<Proceed | abandon | revise>. One sentence tying the decision to the question.

## Next step

<One concrete action with owner and deadline>. See `references/next-steps.md`.
```

Rules for the memo:

- The question stays verbatim from D1. Rewriting it during capture is moving the goalposts.
- The Decision is one sentence. If it needs more, the prototype answered a different question than the one stated.
- The Next step is one action, not a list. Multiple actions go through `references/next-steps.md` to become a task list.

## ADR (Nygard 2011)

For retained architectural decisions: tracer bullets, walking skeletons, anything that lands in production. File at `docs/adr/<NNNN>-<slug>.md` where `<NNNN>` is the next four-digit serial in that directory.

```markdown
# <NNNN>. <Title>

Date: <YYYY-MM-DD>
Status: <proposed | accepted | superseded by NNNN>

## Context

The forces in play. What problem the system faces. What constraints apply (regulatory,
performance, team, deadline). One to three paragraphs.

## Decision

The position taken, active voice: "We will…". One paragraph. The decision is the thesis;
everything else is grounds.

## Consequences

What becomes easier. What becomes harder. What becomes impossible. The tradeoffs accepted.
List the second-order effects you can name.
```

Rules for the ADR:

- Active voice in Decision: "We will use Postgres" not "Postgres will be used".
- Consequences must include at least one negative. An ADR with only upside is incomplete.
- Status `proposed` is fine to file; `accepted` requires the explicit sign-off of whoever owns the area.
- Superseded ADRs stay in the directory. They are the audit trail.

## Eval set

For LLM behavioural prototypes. Two files at `evals/<slug>/`:

**`evals/<slug>/prompt.md`** — the prompt under test, with metadata:

```markdown
# <Design question>

Model: <claude-opus-4-7 | claude-sonnet-4-6 | ...>
Date: <YYYY-MM-DD>
Status: <iterating | converged | abandoned>

---

<system prompt body>
```

**`evals/<slug>/cases.jsonl`** — one JSON object per line:

```json
{"id": "case-001", "input": "...", "expected": "...", "notes": "...", "result": "pass|fail|inspect"}
```

Rules:

- Start with five to ten cases covering the obvious wins and the obvious failures. Grow the set as edge cases surface.
- The `expected` field is the behaviour, not the exact string. "Should refuse and explain why" is a valid expectation.
- The `notes` field carries the reason the case is in the set. Without notes the eval rots as the prompt evolves.
- A case that flickers between pass and fail across runs is a signal, not noise. Record the flicker explicitly.
- The prompt converges when ten consecutive runs hold pass rate stable. Until then the prototype is not done.

## RFC / RFD

For changes that need cross-team discussion before commit. File at `docs/rfc/<NNNN>-<slug>.md`. The template is project-specific; if no convention exists, use the ADR template with these additions:

- **Stakeholders.** Names and teams who must sign off.
- **Alternatives considered.** At least two, with one-paragraph evaluation each.
- **Open questions.** What is still unresolved. Resolve before status moves to `accepted`.

The RFC is the heaviest artifact in this skill. Reach for it only when the decision touches more than one team or reverses an earlier architectural commitment.

## Picking the artifact when intent and capture conflict

If `intent=throwaway` and `capture=adr`, stop and ask. An ADR commits the system to the decision; throwaway code cannot back that commitment. Either the intent is actually retained, or the artifact should be a memo.

If `intent=retained` and `capture=memo`, stop and ask. A memo does not carry the constraint context that future engineers will need; the decision will be re-litigated later. Either the intent is actually throwaway, or the artifact should be an ADR.
