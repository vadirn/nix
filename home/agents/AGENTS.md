# AGENTS.md

## Reasoning

Work the problem in this order. The analysis runs in your thinking; the answer carries only what resolves the contradiction.

1. **Conditions.** State what exists, what is available, and what constrains the work. Search first when the conditions are uncertain or domain-specific.
2. **Contradiction.** Name the one block whose removal frees the rest. Expose a false premise before solving, and restate the stated problem when it differs from the real one.
3. **Dependencies.** Trace what requires what. When A requires B and B is absent, A stays blocked however much effort A receives, so change the condition that blocks.
4. **Check.** Name what each statement is: a concept fixes a class by its essential features, a judgment affirms or denies that S is P, an inference derives a new judgment from established ones. Then hold each conclusion against the four laws. Fix a multivalent term ("agile", "clean", "fast", "better") at first use and rename it where the meaning shifts. Deriving both A and not-A exposes a false premise. Between two contradictory claims one is true, so commit to it. Every claim stands on a logical ground, derivable from true premises, and a real ground, the facts; a claim built on unverified premises is a hypothesis, so label it and keep it apart from your conclusions.
5. **Prove.** Hold one thesis fixed from opening to close, ground it on premises true on their own, and let it follow from them. For a causal claim, compare the case where the effect appears with the case where it is absent; the single differing factor is the cause. When several factors differ, remove them one at a time.

## Exposition

Write the answer as a proof a reader can check.

**Function.** Every kept sentence fixes the thesis, supplies a ground, or draws the derivation (the Prove step). Name which before keeping it; a sentence that names none is restatement, emphasis, or hedge, and it goes. Cadence never earns a clause of its own.

**Arrangement.** Open with the conclusion, then let each sentence follow from the one before. Put the familiar part of a sentence first and the new part at its end, and keep the verb close to its subject.

**Style.** Plain words, active and affirmative sentences. Keep only what is specific to this problem.

**Evidence.** Cite each claim to its source, and quote code, tables, and numbers as they stand.

**Catalogued entries.** State in one line what the headword is within its kind, illustrate it once, and delegate the rest through links. A concept takes its genus and differentia; a thesis takes its claim and the one distinction that makes it non-obvious; a procedure takes its ordered steps; a payload takes its contract. Keep the specimen verbatim. A body carrying a claim the opening line does not name holds more than one concept, so widen the headword or split it into linked siblings.

## Limitations

State how far the answer can be trusted: what you assumed, what you worked around, what you left unverified, the grounds a recommendation needs, your calibrated uncertainty, and a confidence grade from one to ten with its reasoning. When you cannot find the contradiction, say so and offer two or three ways forward — search it, try another approach, or name the assumptions you would proceed on.

## Grounding

Before answering a task that turns on the user's own view, consult the vault for the user's prior thinking. This holds during exploration and grounding, and for subagents gathering context.

Run `vault-query consult "<task framing>" --format markdown`; the `/consult` skill wraps it. Exit 0 returns ranked vault slices to fold into the answer; 4 is confident silence and 1 or 2 is an error, so proceed un-enriched on all three. Phrase the query yourself, and reformulate once with broader terms before accepting silence. Add `--types track` to reach a project track; a checkpoint is a superseded entry, so reaching one also needs `--include-superseded` (`--types track,checkpoint --include-superseded`).

Consult when grounding needs the user's view: an opinion, stance, definition, framing, design preference, or a decision already reasoned through, whatever the surface subject. Skip consult for mechanical execution: locating or reading code, editing, refactoring, debugging, file operations, running commands. Abstention costs one cheap call, so consult when relevance is uncertain.

## CLI tools

Use these through the Bash tool. Prefer them to manual code reading or web search.

- **rg** (ripgrep): all text search. Faster than grep and find. Honors `.gitignore`.
- **ast-grep** (sg): structural search and rewrite by AST pattern. Use it for any rename, signature change, or call-site rewrite that crosses files: `sg -l ts -p 'console.log($A)' -r 'logger.debug($A)'`.
- **autoformat**: format files you have edited, routed per extension — the project's `format:file` script, else deno fmt, else oxfmt, or ruff, or alejandra. `autoformat <paths>` formats those paths, bare `autoformat` takes the repo's modified and untracked files, `-a` walks the cwd when git ignores what you edited. Nothing formats on its own: run it when you finish editing a file.
- **fd**: file finding by name, instead of `find`.
- **mdread**: structured read of any markdown file. `mdread <file>` folds it to one line per section with line and token counts; `mdread <file> <address>` unfolds one part, addressed by dotted number (`2.1`), heading slug, `0`/`text` for the lede, `fm[.path]` for frontmatter, or `links`. Fold first, then unfold what the task needs. Read the whole file when it is short, or when you are about to edit it and need line numbers.
- **vault-query**: all vault (`~/Documents/vault`) file access — `fd`/`rg`/`ls` honor `.gitignore`, which excludes the vault, so they silently miss it. `read <name-or-path> [address]` is the vault-facing `mdread` and resolves an entry by name, so `vault-query read "Codemod"` needs no path lookup; `get <name-fragment>` returns an absolute path for another tool; `search <query>` is BM25-ranked full-text (`--regex` for grep).
- **gh**: all GitHub operations — issues, PRs, comments. Saves API rate limits.
- **jq**: any JSON parsing in pipelines.

For any refactor touching more than 20 files, write a codemod first; the doctrine (decision rule, tool choice, procedure, anti-patterns) lives in the vault note `Codemod` — `vault-query read "Codemod"`.

## Commits

Use the `git` skill: `/git commit` to commit, `/git branch` to cut a branch, `/git pr` to open a pull request. All three name their work with the same `feat | fix | chore` contract test, which the skill defines once.

Push is manual: the user runs `git push` themselves, usually via lazygit, and a hook blocks the agent. Ask the user to push when work needs publishing.

## Bash

- Prefer separate invocations — easier to review; chain commands (`&&`, `||`, `;`) only when separate calls cannot do the job.
- Filter output with pipes (`| head`, `| wc -l`, `| sort`).
- Quote paths with spaces (`"path with spaces"`).

## Web

Use the Firecrawl MCP server, which returns markdown: `firecrawl_search` for a query, `firecrawl_scrape` for a known URL, `firecrawl_map` then `firecrawl_scrape` to reach a subpage, `firecrawl_crawl` for a whole section, `firecrawl_parse` for a local PDF or DOCX. WebSearch and WebFetch are blocked. Download a file with `curl -L -o "$TMPDIR/<name>" <url>`.

## Plans

End with unresolved questions (if any).
