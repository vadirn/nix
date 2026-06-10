## Verdict summary

| Skill | Verdict | One-line reason |
|-------|---------|-----------------|
| bench | cut | No consumer reads its output format; documents a pattern the actual pipeline never follows |
| writing-en | keep | Four-pass structure with sourced rules is justified; minor rework items only |
| writing-en | rework | Single-pass claim contradicts pass-2 loop; early-exit behavior undisclosed in SKILL.md |
| affirm | rework | File-path support advertised but no Read step; routing boundary with writing-en undefined |
| codemod | rework | `/tmp` hardcoded instead of `$TMPDIR`; verify entrypoint has no discovery step |
| commit | rework | Secrets handling contradicts itself across two steps; rm is dead in both branches |
| consult | rework | Exit-code comment mismatches CLAUDE.md; "Default corpus" implies a CLI default that doesn't exist |
| debate | rework | rounds=7 default with only 3-round workflow; evidence strategy contradicts itself |
| design | rework | `constraints[:count]` silently drops one constraint every default invocation |
| experiment | rework | No fallback when template Read fails; vault_root validity unchecked before mkdir |
| git-branch | rework | confirm-skip rule lives only in Rules, not in pseudocode; the two contradict |
| glossary | rework | un-pinned row append-only rule contradicted by update-mode's "editing in place" option |
| grade | rework | debate/grade routing boundary is one-directional |
| handoff | rework | `mktemp -u` comment claims "reserves" the name, which is factually wrong |
| imagen | rework | "Nano Banana does not support multi-ref" is factually false; threshold has no real ground |
| imagen-fal | rework | --name docs claim "first 5 words" but script truncates at 40 chars; --dry-run undocumented |
| imagen-nanobanana | rework | `existsSync` not imported; iterate block contradicts Notes on chroma-key automation |
| justify | rework | No trigger phrases beyond slash command; skill undertriggers on natural language |
| logic-check | rework | Conclusion indented as sub-bullet of last premise in both report templates |
| markitdown | rework | Description/body mismatch on exclusions; no trigger list or skip clause |
| pr | rework | "then stop" after /commit contradicts Rules "commit first"; update branch has no procedure |
| probe | rework | depth parameter declared but never acted on in any procedure branch |
| project-setup | rework | No fallback when templates/Project.md absent; wire-only check reads context.md, misses folder-only case |
| prototype | rework | Component-stub method in matrix has no dispatch branch and no reference file; variants parameter is dead |
| pseudocode | rework | "refactoring skill instructions from prose" trigger matches skill-creator with no skip clause |
| tdd | rework | No YAML frontmatter; reference files cited with no loading-timing guidance |
| track | rework | Dispatch matches only "save" literally; "wrapping up" and "end of session" mis-route to read |
| vault | rework | search.md and context.md never loaded; experiments subcommand has no dispatch branch |
| vercel-react-best-practices | rework | Description too sparse to trigger; server-auth-actions misclassified as performance not security |
| vidgen-fal | rework | "animate this" trigger fires for image-to-video which the script cannot fulfill; --scale validation contradicts docs |
| work | rework | in-context aside handling contradicts delegation classifier |
| writing-ru | rework | "за один проход" contradicts pass-2 explicit loop |

---

## What is justified

**Skill ecosystem boundaries.** The probe/debate/grade/justify/experiment family all cross-reference each other, and the boundary directions are mostly correct. Changing any of these routing contracts should be done carefully — the asymmetry between probe (stress-test a plan) and debate (open comparison) is intentional, not a bug.

**File-per-entity progressive disclosure.** The vault, writing-en, writing-ru, logic-check, and prototype skills all load reference files on demand rather than embedding rules inline. This is the right architecture: each SKILL.md stays well under 500 lines while the full rule sets remain available. Do not collapse these into single files.

**Atomic write patterns.** The `tmp + mv` write pattern in track/save.md and experiment is correct. The `Write to /tmp/claude/commit.txt` + `-F` pattern in commit is the right fix for zsh history expansion. The `rm before Write` pattern in pr is correct given the Write tool's no-overwrite behavior. These are working failure-prevention mechanisms.

**Constraint sets and decision tables.** The design skill's predefined constraint sets per domain (api, data, cli, config, pipeline) and the imagen hub's routing decision table are well-grounded. The constraint sets force genuine architectural diversity; the routing table documents real provider capability differences. Both earn their place.

**Hook-mediated artifact gates.** The commit-msg hook checking for `/tmp/claude/commit.txt` and the `require-pr-body-file.sh` PreToolUse hook checking for `/tmp/claude/pr.md` are the strongest enforcement mechanisms in the set. They enforce skill use from outside the agent's trust boundary. Do not weaken or remove them.

**Mock-at-boundaries-only in tdd.** The rule in mocking.md targeting only external system boundaries, not internal collaborators, is grounded in established test-coupling antipattern literature. The three-pass structure (skeleton → thin path → behavior) prevents horizontal bulk-test generation. Both are load-bearing.

**Four-pass structure in writing-en and writing-ru.** Each pass operates at a different linguistic unit (words, sentences, paragraphs, AI patterns). Interleaving would produce conflicting edits. The structure is correct and the don't-overcorrect guard in pass-4 is necessary to prevent destructive over-editing.

---

## Cut list

### bench
- **`bench/SKILL.md` entire file.** No file in the skills tree reads `.meta.json` or `elapsed_seconds`; skill-creator reads `total_duration_seconds` from `timing.json` via a completely different interface. Delete the skill directory.
- **`bench/SKILL.md` Reference section (lines 25–43).** The bash snippet and `.meta.json` block duplicate the two-line pseudocode above them with no additional edge-case handling.

### vercel-react-best-practices
- **`SKILL.md` "When to Apply" section (lines 12–19).** The skill-creator guide states "all when-to-use info goes in the frontmatter, not in the body." These five bullets belong in the description, not the body.

### work
- *(no upheld cut findings)*

### probe
- *(no upheld cut findings)*

### commit
- **`SKILL.md` procedure line with `Bash(rm -f /tmp/claude/commit.txt)`.** The commit-msg hook deletes the artifact at line 50 on success; the skill's explicit rm runs against an already-absent file in the happy path and is unreachable in the failure path.

### prototype
- **`SKILL.md` Parameters pseudocode block, line 77: `variants = <args>.variants or 1`.** This variable is assigned once and never read, branched on, or passed in the pseudocode or any reference file. Dead parameter.

---

## Add / clarify list

### tdd
- **`SKILL.md` top of file — missing YAML frontmatter.** Add `name: tdd` and a `description` field with trigger phrases (`/tdd`, "write tests first", "test-driven", "TDD", "red green refactor", "write a failing test") and skip rules (bug fix → use /experiment; feasibility spike → use /prototype). Without frontmatter the skill cannot appear in the available-skills routing list.
- **`SKILL.md` — reference file loading guidance.** Both `tests.md` and `mocking.md` are cited inline without loading-timing instructions. Add a "Reference files" section: read `tests.md` before step 4; read `mocking.md` when step 2 raises a boundary question.

### affirm
- **`SKILL.md` Parameters block — file-path branch missing.** The description says the skill "Works on inline text, files, or conversation context" but the procedure has no Read step and no branch for file paths. Add: "if text looks like a file path, read the file first, then apply transforms to its content, then write the result back."
- **`SKILL.md` frontmatter description — routing boundary with writing-en.** Add a skip line: "Skip for general prose editing (use /writing-en); affirm targets instruction text specifically."

### codemod
- **`SKILL.md` Procedure step 1 — hardcoded `/tmp/codemod-samples/`.** CLAUDE.md explicitly prohibits `/tmp` and requires `$TMPDIR`. Replace `/tmp/codemod-samples/` with `$TMPDIR/codemod-samples/`.
- **`SKILL.md` Procedure step 4 — verify entrypoint lacks a discovery step.** Three alternatives are listed with no procedure for determining which applies. Add a discovery sub-step: "check `package.json` scripts, Makefile targets, and `./scripts/` in that order; if none found, run the project test command and note the gap."

### commit
- **`SKILL.md` procedure — secrets contradiction.** The staging step says "warn and exclude secrets"; the needs_confirmation guard says "or secrets detected." These cannot both be literally true. Collapse to one decision point: exclude secrets and set a flag during staging; reference that flag in needs_confirmation instead of re-detecting.

### consult
- **`SKILL.md` Procedure block — `// typed exit codes: 0 / 4 / 1` comment.** CLAUDE.md names exit 2 as an error case but `vault-query consult` never emits exit 2. Change to: `// exit codes: 0=results, 4=abstain, 1=error (vault-query never emits 2 from this command)`.
- **`SKILL.md` Scope and flags — "Default corpus is the user's own writing: --types card,note,experiment".** The CLI has no configured default types; omitting `--types` searches all types. Replace "Default corpus" with "This skill always passes `--types card,note,experiment`".

### debate
- **`SKILL.md` Parameters — `rounds=N` default 7 with only a 3-round workflow.** The workflow defines behavior only for R1, R2, R3; R4–R7 have no instructions. Either lower the default to 3 or add a general-purpose middle-round template.
- **`SKILL.md` pseudocode — `evidence_base` vs `evidence=search_each_round` contradiction.** The pseudocode pre-compiles one evidence_base before the debate; the workflow framing declares `evidence=search_each_round`. Pick one strategy and remove the other.

### design
- **`SKILL.md` Reference — `constraints[:count]` silently drops one constraint.** Every domain has 4 predefined constraints; the default count is 3. The slice silently drops the fourth on every default invocation. Either reduce each set to 3 entries or change the default to 4.
- **`SKILL.md` Reference — api constraint 4: "take cues from a specific well-known library".** This constraint delegates the library choice to the subagent at runtime, making designs non-reproducible and structurally unlike the other three constraints. Replace with a concrete structural constraint (e.g., "Builder pattern: construction separated from use via a fluent builder or factory").
- **`SKILL.md` pseudocode — `auto-detect fails` is never defined.** Without a definition, agents ask probing questions on every invocation. Add: "Auto-detect matches the topic against domain keywords (cli: flag/command/argv; api: function/method/interface; data: schema/table/model; config: settings/env; pipeline: workflow/job/step). If none match, fall back to general."

### experiment
- **`SKILL.md` procedure line `template = Read(<vault_root>/templates/Experiment.md)` — no fallback.** If the file is absent the procedure halts with a partially-executed experiment. Add: "if Read fails: instantiate inline from Reference §Record template and note the fallback in the Execution field."
- **`SKILL.md` procedure — `vault_root` validity check missing before `mkdir`.** If `vault-query config` succeeds but returns an empty `vault_root`, `mkdir` runs against an empty string. Add before mkdir: "if `vault_root` is empty or null: surface 'vault_root not set' and skip Capture."

### git-branch
- **`SKILL.md` pseudocode vs Rules — confirm-skip contradiction.** Pseudocode shows `AskUserQuestion` unconditionally; the skip condition ("skip when the user supplied an explicit name") appears only in Rules. Add an explicit branch in the pseudocode: "if user_supplied_name: skip confirm; else: AskUserQuestion(...)".
- **`SKILL.md` Reference — "suggest committing first" absent from pseudocode.** The dirty-on-default pseudocode silently branches from HEAD; the Reference section introduces a conditional suggestion to commit first with no corresponding pseudocode node. Either remove the sentence or add a step: "if dirty and changes_belong_on_current_branch: suggest committing before branching."

### glossary
- **`SKILL.md` line 86 vs line 102 — un-pinned row mutability contradiction.** Line 86 states un-pinned rows are append-only; line 102 offers "editing in place" as a co-equal option in the conflict prompt. Remove "editing in place" from the conflict prompt in line 102.
- **`SKILL.md` lines 4–6 — trigger "what does X mean in this codebase" misfires.** The skill has no lookup or query mode; triggering here starts a glossary-building workflow. Remove this trigger phrase until a read-only query mode is added.
- **`SKILL.md` line 22 — `--inline` branch is a stub.** No parse instructions, no mode assignment, no fallback when no file is named. Specify: "existing_table parsed from the named file's `## Glossary` section using the same 2-col parse logic as update mode; if absent, `existing_table = { pinned: [], unpinned: [] }`."
- **`SKILL.md` line 16 — `scope=path` parameter unbound in pseudocode.** The path value is never assigned to a variable. Add at the top of the pseudocode: `scan_root = args.path if scope == "path" else CWD`.

### grade
- **`SKILL.md` frontmatter — debate/grade routing boundary is one-directional.** Grade routes open questions to `/debate`; debate does not route single-confidence-score requests to `/grade`. Add a skip line to grade's frontmatter: "Skip when the user wants both sides argued rather than a single confidence score (use /debate)."

### handoff
- **`SKILL.md` line 26 — `mktemp -u` comment says "reserves".** `mktemp -u` prints a name without creating or reserving anything. Rewrite: "`-u` prints a name without creating the file; another process could claim it in the window before Write, but collision is negligible for single-machine temp files."

### imagen
- **Routing table — "Nano Banana does not support multi-ref" is factually false.** The nanobanana script accepts `--source` as repeatable up to 10 images (line 32) and sends them all as `inline_data` parts. The `ref_count >= 4` threshold has no real ground. Replace with an accurate justification or change the threshold and signal name to reflect actual routing intent (e.g., multi-reference style remix vs. single-source editing).

### imagen-fal
- **`SKILL.md` flag table, `--name` row.** States "slugified first 5 prompt words" but the script (line 214–219) slices the full lowercased-and-hyphenated prompt to 40 characters with no word-count logic. Change to "slugified prompt, truncated to 40 characters."
- **`SKILL.md` flag table — `--dry-run` missing entirely.** Implemented at lines 97, 115, 320–332 of `imagen-fal.ts`. Add a row: "Print the resolved request payload as JSON and exit without making any API call. No FAL_KEY needed."
- **`SKILL.md` flag table, `--aspect` row — defaults undocumented.** Line 173 sets `ASPECT` to `auto` for i2i and `1:1` for t2i when `--aspect` is omitted. Add "Default: 1:1 for text-to-image, auto for image-to-image (o1)" to the row description.

### imagen-nanobanana
- **`scripts/imagen-nanobanana.ts` line 14 — `existsSync` not imported.** Called at line 384 but not in the `import { mkdirSync, writeFileSync, appendFileSync } from 'fs'` destructure. Add `existsSync` to that import. This throws `ReferenceError` on every successful transparent image generation.
- **`SKILL.md` lines 74–75 — iterate block contradicts Notes.** "re-run the green-key post-process step" contradicts Notes lines 102–103, which state the script runs ffmpeg in-process automatically. Replace with: "pass `--transparent --cutout colorkey` again; the script re-runs the green-key step automatically."
- **`SKILL.md` line 66 — comment cites non-existent section.** `// see Reference §Transparency via chroma-key` — no `## Reference` section exists. The actual heading is `### Transparency via chroma-key` under `## Notes`. Change to `// see Notes §Transparency via chroma-key`.

### justify
- **`SKILL.md` frontmatter description — no trigger phrases.** The skill-creator guide requires pushy trigger phrases; the current description has only the slash command. Add: "Also triggers on: 'does this need to be here', 'is this justified', 'what can we cut', 'does this carry dead weight', 'audit this diff', 'is this code/step/action necessary'."

### logic-check
- **`SKILL.md` report templates (Russian lines 70–72; English lines 99–101) — Conclusion indented as sub-bullet.** Three-space indent makes `**Вывод:**` / `**Conclusion:**` a nested child of premise 2. Dedent to the same level as `**Тезис:**` / `**Thesis:**` and move outside the numbered list.
- **`SKILL.md` procedure — `if structure was implicit:` condition is undefined.** Nearly all prose has implicit structure; the branch fires unpredictably. Replace with a positive directive: always show the reconstruction before listing violations without asking for confirmation.

### pr
- **`SKILL.md` pseudocode Guard block — "then stop" after `Skill(commit)` contradicts Rules.** The Rules section says "Commit first," implying continuation; "then stop" is ambiguous. Remove "then stop" and fall through to the Push step after commit returns, or make the stop explicit: "then stop and tell user to re-run /pr."
- **`SKILL.md` pseudocode — update branch has no procedure.** After `AskUserQuestion("update or stop?")`, the update path has no documented steps. Add: "if user chooses update: regenerate title/body from diff, confirm, Write(`/tmp/claude/pr.md`, body), `Bash(gh pr edit --title <title> --body-file /tmp/claude/pr.md)`, `Bash(rm -f /tmp/claude/pr.md)`."
- **`SKILL.md` pseudocode — diff and log depend on default_branch but are in the same parallel gather block.** Move `diff = Bash(git diff <default_branch>...HEAD)` and `log = Bash(git log <default_branch>..HEAD --oneline)` into a second sequential step after `default_branch` is resolved.

### probe
- **`SKILL.md` Parameters — `depth=shallow|deep` declared but never used.** No branch in Phase 1, 2, or 3 conditions on `depth`. Either remove it or add a concrete branch: "if depth=shallow: surface only the top 5 branches by criticality."

### project-setup
- **`SKILL.md` Procedure Create branch — no fallback for missing template.** If `templates/Project.md` is absent, the procedure stalls with no inline fallback. Add: "if template not found: Write a minimal project note with status, description, and result fields directly; report that `templates/Project.md` was not found."
- **`SKILL.md` Notes — "The user adds project-specific context to context.md."** Addresses the user, not the agent; the `context.md` template already contains `<!-- filled by user or Claude during setup -->`. Remove the sentence.
- **`SKILL.md` Procedure wire-only branch — existence check reads `context.md`.** A project folder can exist without `context.md` (manually created). The check produces a false negative and triggers the Create branch, overwriting existing content. Change to: "if `<target>` directory exists (any content)" and separately handle the missing-context.md sub-case.

### prototype
- **`SKILL.md` method dispatch — component-stub has no branch and no reference file.** The method matrix names "Component stub / Storybook mock" for look-and-feel throwaway, but the dispatch block has no branch for it and no `references/component-stub.md` exists. Either add the file and branch, or change the matrix cell to "out of scope: use spike or Wizard of Oz" (no new file needed).

### pseudocode
- **`SKILL.md` frontmatter description — "refactoring skill instructions from prose" matches skill-creator with no skip clause.** Add: "Skip when the goal is to create or iterate on a skill holistically — use skill-creator instead." Narrow the trigger to "when a SKILL.md procedure section is written as prose and needs to become a pseudocode block."
- **`SKILL.md` Example section — "Skill(commit), then stop".** Mixes inline prose into a call line, contradicting the Syntax section's three-type rule. Rewrite as two lines: `Skill(commit)` then `stop` on its own line.

### track
- **`SKILL.md` line 17 — dispatch condition `args contains "save"` misroutes save triggers.** "wrapping up" and "end of session" are listed as save triggers in the frontmatter but neither contains "save." Broaden to: `if args matches any of ["save", "wrapping up", "end of session", "закончили"]`.

### vault
- **`references/search.md` — never loaded.** The search branch runs `vault-query` directly with no `Read(references/search.md)` call. Either add the Read call to the search branch or delete the file.
- **`references/context.md` — never loaded.** No dispatch branch reads it; content partially duplicated by the SKILL.md glossary and per-entity files. Delete the file (the 35 experiments/ row should be folded into the SKILL.md glossary instead).
- **`SKILL.md` dispatch — `experiments` subcommand has no branch.** A user invoking `/vault experiments` falls through to the else branch returning `vault-query config` JSON. Add: `elif 'experiments': results = Bash(vault-query experiments); do('present experiments with metadata')`.
- **`references/card.md` line 39, `note.md` line 36, `reference.md` line 21 — template Read calls lack `vault_root` qualifier.** `Read templates/Card.md` resolves against `dir` (skill base directory) which has no `templates/` subfolder. Change each to `Read(<vault_root>/templates/Card.md)` etc., obtaining `vault_root` from `vault-query config` at the top of the branch.
- **`SKILL.md` description — "Excludes raw markdown edits" is ambiguous.** The skill itself creates and edits markdown files. Replace with a concrete exclusion: "direct file edits not routed through /vault (e.g. editing a .md file in a code repo that is not a vault artifact)."

### vercel-react-best-practices
- **`SKILL.md` frontmatter description — too sparse.** Two sentences with no trigger phrases; five "When to Apply" triggers are stranded in the body. Move those triggers into the description and add a skip clause: "Skip for HTML/CSS-first work or non-React JS — use modern-web-guidance instead."
- **`SKILL.md` category table row 3 (server-auth-actions) — misclassified.** `server-auth-actions.md` frontmatter has `impact: CRITICAL` and the concern is security (unauthorized mutations), but the table labels it "Server-Side Performance (HIGH)." Move to a "Security" category or rename the group to "Server-Side Performance & Security" and update impact to CRITICAL.
- **`AGENTS.md` line 17 — "Contains 40+ rules".** The SKILL.md and rules/ directory confirm 57 rules. Update to "57 rules."
- **`SKILL.md` category table rows for `js-tosorted-immutable.md` and `js-length-check-first.md` — impact contradicts rule files.** Both files have `impact: MEDIUM-HIGH` but the table assigns them to category 7 labeled "LOW-MEDIUM." Either update the rule files to LOW-MEDIUM or move them to a MEDIUM-HIGH category.

### vidgen-fal
- **`SKILL.md` frontmatter trigger "animate this" — fires for image-to-video intent the script cannot fulfill.** Remove "animate this" from the trigger list, or add a Skip rule: "Skip when the user passes a reference image and wants image-to-video — the script supports text-to-video only."
- **`vidgen-fal.ts` lines 169–178 vs `SKILL.md` flag reference — `--scale` validation contradicts docs.** SKILL.md says `--scale` "has no effect unless --webm is set" but the script validates `--scale` before the `DO_WEBM` guard, causing `process.exit(1)` for invalid values even without `--webm`. Either move the validation inside the `if (DO_WEBM)` block, or update SKILL.md to say "Invalid values are rejected even without --webm."

### work
- **`SKILL.md` in-context aside handling contradicts delegation classifier.** The in_context_steps check (lines 30–31) answers steps directly when the answer is in context; the delegation classifier states "conversational asides during orchestration are delegated like any other read." These conflict. Either carve out in-context asides from the delegation classifier's rule and state it explicitly, or remove the aside note from the classifier and let the in_context_steps check handle it uniformly.

### writing-en
- **`SKILL.md` line 12 vs `pass-2-sentences.md` lines 29–41 — single-pass claim contradicts pass-2 loop.** "Apply all rules in a single pass" is violated by pass-2's explicit "go to loop" iteration. Amend SKILL.md line 12: "Apply all rules in one reading of the text. Exception: the split-and-reconnect step in pass-2 runs iteratively until stable."
- **`pass-2-sentences.md` line 40 — "show both variants to user → stop" is undisclosed in SKILL.md.** The skill can halt mid-pass and surface variants; SKILL.md gives users no expectation frame for this. Add a "When to ask the user" note to SKILL.md, or eliminate the stop by having the model pick the simpler variant after 2 failed attempts.
- **`pass-1-words.md` lines 85–96 — "Invent fresh comparisons" invites generative failure.** The heading and Orwell procedure invite inventing new figures of speech, but all examples replace dead metaphors with literal statements. Change the rule to: "If the text uses a dead metaphor that obscures meaning, replace it with a literal statement of what is meant. Do not invent new figures of speech."

### writing-ru
- **`SKILL.md` line 12 vs `pass-2-sentences.md` lines 26–37 — "за один проход" contradicts pass-2 loop.** Same issue as writing-en. Rewrite to "за одну редакцию" or add a parenthetical: "(внутри прохода 2 допускается цикл разбивки-склейки)."

---

## Cross-cutting themes

### Theme 1: Description too sparse to route (8 skills)

`tdd` (no frontmatter at all), `codemod` (single sentence, no trigger list, no skip clause), `markitdown` (no trigger list, no skip clause, no slash-command mention), `vercel-react-best-practices` (two sentences, five triggers stranded in body), `project-setup` (two triggers, no skip clause), `pseudocode` (trigger list with no skip clause), `glossary` (trigger list with no skip clause), `affirm` (trigger list with no skip clause pointing to writing-en).

The dominant pattern across the mature skills is: slash command + 3–5 natural-language trigger phrases + at least one skip clause naming the adjacent skill. Every skill above is missing at least two of those three components.

### Theme 2: Description/body mismatch (5 skills)

`affirm` (advertises file-path support, no Read step in body), `track` (describes "wrapping up" as a save trigger, dispatch matches only "save"), `work` (description omits re-entry trigger that the body supports), `markitdown` (description's exclusion clause names only PDF manipulation; body excludes DOCX editing, form-filling, splitting), `pr` (description's commit-first skip implies continuation; body's "then stop" contradicts it).

Pattern: the frontmatter description and the procedure body were written at different times and not reconciled.

### Theme 3: Duplicated global rules from CLAUDE.md (4 skills)

`codemod` Decision section (near-verbatim restatement of CLAUDE.md's 20-file threshold), `commit` Rules section ("Run git commands separately. Chained commands bypass the permissions allowlist" is verbatim CLAUDE.md), `pr` Rules section (same chained-commands rule), `git-branch` separate-commands rule.

Since CLAUDE.md is always in context, skill-level duplication adds maintenance surface without adding capability. Where the per-skill review upheld cuts of these, the cut is warranted. Where it didn't, leave the rule but note the drift risk.

### Theme 4: Reference file loaded at wrong time or not at all (4 skills)

`vault` (`references/search.md` and `references/context.md` are never loaded by any dispatch branch), `tdd` (`tests.md` and `mocking.md` cited without loading-timing guidance), `prototype` (method dispatch has no branch for component-stub, so no reference file is ever loaded for that method), `experiment` (template Read has no fallback, silently halting on missing file).

### Theme 5: Unguarded or missing fallback for absent vault/template files (4 skills)

`experiment` (no fallback when `templates/Experiment.md` is absent), `project-setup` (no fallback when `templates/Project.md` is absent), `vault` card/note/reference sub-files (template paths not qualified with `vault_root`), `glossary` (missing — though the upheld finding here is the mutable/immutable contradiction rather than a missing fallback).

### Theme 6: Dead parameters or dead configuration (3 skills)

`probe` (`depth=shallow|deep` declared but no branch conditions on it), `prototype` (`variants = <args>.variants or 1` assigned once and never read), `design` (`constraints[:count]` silently drops one predefined constraint on every default invocation due to count/set-size mismatch).

### Theme 7: Single-pass claim contradicts iterative reference file (2 skills)

`writing-en` (SKILL.md line 12: "apply all rules in a single pass"; pass-2-sentences.md lines 29–41: explicit loop with go-to), `writing-ru` (SKILL.md line 12: "за один проход"; pass-2-sentences.md lines 26–37: same loop construct). Same root cause in both: the reference files were updated with an iterative loop but the SKILL.md promise was not reconciled.

---

## Routing layer

### Confirmed: experiment / grade / probe three-way collision

Per-skill reviews upheld the `grade` → `debate` one-directional boundary (grade finding on "debate/grade routing boundary is one-directional"). The per-skill reviews did not find a three-way collision as a single upheld finding, but the grade/debate gap was upheld (confidence 7), and the experiment/prototype boundary was noted as unresolved from prototype's side. The `probe` depth parameter being dead (upheld, confidence 9) makes probe's own self-description partially unreliable, compounding any routing ambiguity.

Confirmed actions from per-skill reviews: add a skip line to grade's frontmatter pointing to `/debate` for open argumentation; add to prototype's description: "Skip when testing an existing behavior against a falsifiable claim without building new code (use /experiment)."

### Confirmed: debate / design one-directional boundary

The per-skill debate review did not uphold a finding requiring a `/probe` mention in debate's description, but the per-skill design review noted (though did not uphold) the missing prototype boundary. The routing-layer observation that `design` says "Skip when comparing existing options (use /debate)" but `debate` does not reciprocally say "Skip when generating new options (use /design)" is consistent with the per-skill findings. The fix is already implied by grade's pattern: add a skip clause to debate pointing to design for option-generation requests.

### Confirmed: track dispatch misroute

Upheld at confidence 9 in the track per-skill review: "wrapping up" and "end of session" are listed as save triggers in the frontmatter but mis-route to read.md because the dispatch matches only the literal string "save." This is a concrete behavioral failure that also affects the handoff/track routing distinction — a user saying "wrapping up" expecting a track save will receive a track read instead.

### Confirmed: writing-en / affirm overlap

The affirm per-skill review upheld the routing ambiguity finding (confidence 8): a routing agent choosing between affirm and writing-en on "make these instructions more direct" has no tie-breaking rule in either description. Fix: add a skip line to affirm pointing to writing-en; add a reciprocal note in writing-en pointing to affirm for instruction/prompt files.

### Not confirmed: consult / vault collision

The consult per-skill reviews did not produce an upheld finding about vault routing ambiguity. The descriptions separate on the user's own judgment (consult) vs. general knowledge (vault). The routing-layer concern about "what have I already reasoned about X" is real but speculative, not grounded in a demonstrated failure from the per-skill pass.

### Not confirmed: handoff / track cross-session state collision

The per-skill handoff reviews did not uphold the claim that "capturing state before you /clear" overlaps with track's save trigger (finding upheld: false for the specific description-rewrite proposal). The boundary is stated in handoff's §Boundaries section and in the description's "ephemeral" label. The overlap exists at the linguistic surface but not at the implementation level.

---

## Prioritized actions

1. **Delete `bench/` entirely.** Zero consumers, wrong output schema, misleading description. Pure dead weight with no rework path. (1 file, 44 lines)

2. **Fix `imagen-nanobanana.ts` line 14 — add `existsSync` to the `fs` import.** Runtime `ReferenceError` on every successful transparent image generation. Highest-severity bug in the set. (1-character change)

3. **Fix `track/SKILL.md` dispatch condition** — change `args contains "save"` to match all save-trigger phrases ("wrapping up", "end of session") listed in the frontmatter. Concrete behavioral failure affecting the most commonly used save phrases.

4. **Add YAML frontmatter to `tdd/SKILL.md`** — the skill cannot appear in the available-skills routing list without `name` and `description`. Blocks all routing to the skill.

5. **Fix `codemod/SKILL.md` step 1** — replace `/tmp/codemod-samples/` with `$TMPDIR/codemod-samples/`. Will fail in sandbox mode as written; CLAUDE.md explicitly prohibits `/tmp`.

6. **Fix `vercel-react-best-practices` AGENTS.md rule count and category-table misclassifications** — update "40+ rules" to "57 rules"; move `server-auth-actions` out of "Server-Side Performance" and into a "Security" category; reconcile `js-tosorted-immutable` and `js-length-check-first` impact levels between rule files and the category table.

7. **Fix `pr/SKILL.md` pseudocode** — (a) resolve "then stop" ambiguity after `Skill(commit)`, (b) add the update-branch procedure after `AskUserQuestion("update or stop?")`, (c) move `diff` and `log` gather steps into a sequential block after `default_branch` is resolved.

8. **Fix `vault` dead reference files and missing dispatch branch** — delete `references/search.md` and `references/context.md`; add an `experiments` dispatch branch; qualify all template Read paths with `<vault_root>`.

9. **Reconcile single-pass claims in `writing-en` and `writing-ru`** — amend SKILL.md line 12 in both skills to acknowledge the pass-2 iterative loop; add early-exit disclosure to writing-en's SKILL.md for the "show variants → stop" behavior in pass-2.

10. **Fix `imagen` routing table** — replace the false ground "Nano Banana does not support multi-ref" with an accurate justification for the `ref_count >= 4` threshold (or change the threshold and signal name to reflect the actual distinction between multi-reference style remix and single-source editing).
