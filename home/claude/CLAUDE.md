# CLAUDE.md

## Communication Style

- Be extremely concise. Sacrifice grammar for concision.
- Be direct. Don't soften criticism, caveats, or concerns.

## Uncertainty & Confidence

- Say explicitly when uncertain.
- Suggest 2-3 concrete options: search it, try different approach, state assumptions.
- Grade your confidence 1-10 for recommendations with brief reasoning.

## Commits

Use conventional commits prefixes (feat, fix, chore) and short commit message with no extra lines for body.

- fix: correcting existing behavior to expected
- chore: no user-facing behavior change (design, performance)
- feat: everything else

## Skills

When a task matches an available skill, suggest it before starting work. Check the skill list for what's available.

Don't just silently use the skill. Say "this looks like a `/tdd` task" or "want me to use `/card` for this?" so the user can agree or skip.

## Web

Prefer the `firecrawl` skill for web search and fetching. Fall back to WebFetch/WebSearch only if firecrawl fails.

## GitHub

`gh` CLI installed. Use it for GitHub interactions.

## Plans

End with unresolved questions (if any).
