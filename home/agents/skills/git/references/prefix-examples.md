# Prefix example bank

Worked calls for the three-question contract test in `SKILL.md`. These illustrate which prefix to choose, not message style.

_Contract changes (`feat`):_

- "add retry logic to API client" — new promise → `feat`
- "remove deprecated /v1 endpoint" — contract narrowed → `feat`
- "drop deprecated `orders.legacy_status` column" → `feat`
- "tighten return type from `any` to `User`" — type signature is part of the contract → `feat`

_Contract repairs (`fix`):_

- "fix typo in error message" — error text is part of the contract → `fix`
- "patch credential-leak in token handler" — implicit safety promise was violated → `fix`
- "correct wrong example in public API docs" — public docs are the contract → `fix`

_Below the contract (`chore`):_

- "extract request helper" — contract unchanged → `chore`
- "cache user lookup, 50ms → 2ms" — speed sits below the contract line → `chore`
- "page was 30s, now 1s; resolves slowness ticket" — same → `chore`
- "add concurrent index on `orders.user_id`" — backward-compatible migration → `chore`
- "add Korean translations" — localization sits below the contract line → `chore`
- "polish internal README" — internal docs sit below the contract line → `chore`
- "bump dependency, no API impact" → `chore`
- "add unit test for existing behavior" → `chore`

_Special:_

- Reverts: apply the three-question test to the revert's effect on the contract. Reverting a buggy release restores a violated promise → `fix`. Pulling a feature narrows the contract → `feat`.
