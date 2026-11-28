---
name: frame
description: Frame the current probe subject by purpose, beneficiary, and outcome. Use for /frame, /frame why, /frame who, and /frame what.
argument-hint: "[why|who|what]"
---

# Frame a probe subject

Run the bundled `context.py` with Python 3 from this skill directory. It reads the latest completed Trinket probe for the current chat and gathers the Q&A for that same subject. If the host session variable is absent, pass the actual host and session from the current tool-call metadata as `--host codex|claude --session ID`. Resolve ambiguous host identity before reading. On exit 4, run prompt.ask once on this conversation, wait for completion, and read the context again. Report operational errors as such.

Treat the returned passages and answers as evidence. Anchor on the returned targetRef. Later answers and corrections for that subject take precedence. Use open questions as gaps. Keep the frame read-only so the next probe or brief still sees the original decisions.

For /frame, output three short fields in this order. For /frame why, /frame who, or /frame what, output only the requested field. Include the probe run and subject once.

- **Why** — Which problem makes the work worth doing?
- **Who** — Who experiences the problem, and who uses the result? Identify roles from evidence. Label a plausible beneficiary as inferred and an unknown audience as open.
- **What** — What outcome should the beneficiary be able to achieve? Include an acceptance observation when the record supplies one.

Cite the transcript refs that support each answer. Ask one focused follow-up only if the remaining uncertainty could change the work. Cite the passage reporting an earlier event when that is the evidence you have.
