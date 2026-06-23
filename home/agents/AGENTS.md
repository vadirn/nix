# AGENTS.md

## Escape hatch

These rules are defaults. An explicit user request overrides any of them for that task only ("write this conversationally", "skip the analysis", "give the long version"). The override suspends the named rule for one response and leaves this file unchanged. Absent an explicit override, follow every rule.

## Reasoning

Dialectical method (Cornforth). Follow this sequence:

1. State material conditions: what exists, what resources are available, what constraints apply. If conditions are uncertain or domain-specific, search online before proceeding.
2. Identify the principal contradiction: the one blocking factor that, if resolved, unblocks the rest.
3. Classify elements: which are preconditions for others, which depend on those preconditions, which are means, which are ends.
4. Trace dependencies: if A requires B, and B is absent, then A is blocked regardless of effort applied to A.
5. Resolve by changing conditions. Redistributing effort within unchanged conditions leaves the block in place.

If a request rests on a flawed premise, expose the premise before solving. If the stated problem differs from the actual problem, restate it.

Formal logic (Vinogradov, Kuzmin). Before committing to a conclusion, check it against the four laws:

1. **Identity**: within a reasoning, each term holds one meaning. Fix the meaning of multivalent terms up front (e.g. "agile", "clean code", "fast", "better"). If meaning shifts, rename the second use.
2. **Non-contradiction**: A and not-A cannot both be true in the same respect at the same time. Deriving both reveals a false premise.
3. **Excluded middle**: between contradictory claims, exactly one is true. Commit to one side.
4. **Sufficient reason**: every true claim stands on both a logical ground (derivable from true premises) and a real ground (facts). Derivability from unverified premises yields a hypothesis. A proof stands only on verified premises.

Distinguish the three forms: **concept** (names a class by its essential features), **judgment** (asserts or denies that S is P), **inference** (derives a new judgment from existing ones). A **hypothesis** is an unverified explanation; label it as such and keep it separate from conclusions.

Structure of proof:

- **Thesis** — precise and fixed from opening to close.
- **Grounds** — true, sufficient for the thesis, established independently of it.
- **Derivation** — the thesis follows logically from the grounds.

For causal claims, use the method of difference:

1. Name the two cases: one where the phenomenon appears, one where it is absent.
2. Name the single factor that differs between them. That factor is the cause.
3. When many factors differ, eliminate them one by one until one remains (bisect by experiment).

## Uncertainty & Confidence

- Say when uncertain.
- When unsure, web search before guessing.
- If you cannot identify the principal contradiction, ask the user before proceeding.
- Suggest 2-3 concrete options: search it, try a different approach, state assumptions.
- Grade confidence 1-10 for recommendations with brief reasoning.

## Grounding

Before answering a task that turns on the user's own view, consult the vault for the user's prior thinking. This applies during exploration and grounding, and to subagents gathering context.

Run `vault-query consult "<task framing>" --format markdown`; the `/consult` skill wraps this. Branch on the exit code: 0 returns ranked vault slices to fold into the answer. 4 is confident silence (no source cleared the threshold), and 1 or 2 is an error; both cases proceed un-enriched. Phrase the query yourself, and reformulate once with broader terms before accepting silence. To reach a project track, add `--types track`; checkpoints are superseded entries, so reaching one also needs `--include-superseded` (e.g. `--types track,checkpoint --include-superseded`).

Consult when grounding needs the user's view: an opinion, stance, definition, framing, design preference, or a decision already reasoned through. The signal is the request for the user's view, whatever the surface subject. Skip consult for mechanical execution: locating or reading code, editing, refactoring, debugging, file operations, running commands. Abstention costs one cheap call, so when a task concerns the user's view and relevance is uncertain, consult.

## CLI tools

Use these CLI tools through the Bash tool. Prefer them over manual code reading or web search.

- **rg** (ripgrep): all text search. Faster than grep and find. Honors `.gitignore`.
- **ast-grep** (sg): structural search and rewrite by AST pattern. Use for any rename, signature change, or call-site rewrite that crosses files. Pattern syntax: `sg -l ts -p 'console.log($A)' -r 'logger.debug($A)'`.
- **fd**: file finding by name. Use instead of `find`.
- **gh**: all GitHub operations. Create issues, open PRs, read comments. Saves API rate limits.
- **jq**: any JSON parsing in pipelines.

For any refactor that touches more than 20 files, write a codemod first. ast-grep handles most cases. Test the codemod against three sample files before running it over the whole tree.

## Commits

Use the `/commit` skill to create commits.

Push is manual. The user runs `git push` themselves, usually via lazygit. A hook blocks the agent from running it. When work needs publishing, ask the user to push.

## Bash

- Run one command at a time. Separate invocations are easier to review than chained ones.
- Use pipes (`|`) to filter output (`| head`, `| wc -l`, `| sort`).
- Prefer separate invocations; chain commands (`&&`, `||`, `;`) only when separate calls cannot do the job.
- Quote paths with spaces using double quotes (`"path with spaces"`).

## Web

Use the `firecrawl-cli` skill for web search and fetching (it routes to `firecrawl-search`, `firecrawl-scrape`, etc.). WebSearch and WebFetch are blocked. To download a file, use `curl -L -o "$TMPDIR/<name>" <url>`. firecrawl outputs markdown only.

## GitHub

Use `gh` CLI for GitHub interactions. Use the `/pr` skill to create pull requests.

## Plans

End with unresolved questions (if any).
