# vault-query lint

## Usage

```sh
vault-query lint                              # text digest, default
vault-query lint --format json                # JSON array of findings
vault-query lint --format summary             # counts per rule
vault-query lint --rule orphan-card=error     # promote a rule (repeatable)
vault-query lint --rule singleton-tag=error   # promote singleton-tag to error
```

## When to Use

Run `vault-query lint` as a periodic vault health check, or before a vault-edit session. It surfaces structural issues: orphan cards, broken wikilinks, references not cited by any card, and similar.

The default output is text. Pipe `--format json` to `jq` for machine-readable processing. Use `--format summary` to see counts per rule when triaging.

## Rules

| Rule                          | Default | What it flags |
| ----------------------------- | ------- | ------------- |
| `orphan-card`                 | warn    | Card with zero inbound wikilinks (excludes folder-index cards: `<X>/~<X>.md`) |
| `dangling-reference`          | warn    | Reference not cited by any card's `reference:` frontmatter |
| `dangling-relation-label`     | error   | A bare `## Relations` endpoint or from-label matches no local `## Glossary` term or `## Workflow` step in the same file (a cross-file `[[wikilink]]` target is `broken-wikilink`'s concern, not this rule's) |
| `dangling-requires-target`    | warn    | `type: ticket` entry's `requires:` wikilink names no _ticket_ file in the vault — narrower than `broken-wikilink`, which asks only whether the target resolves to any entry at all, so a `requires:` naming a same-named card or note is still flagged here |
| `reference-not-wikilink`      | warn    | Card's `reference:` value is a non-wikilink string (e.g. raw URL) |
| `reference-wrong-type`        | warn    | Card's `reference:` wikilink resolves to a non-`reference` entry (a target resolving to nothing at all is `broken-wikilink`'s, so one dangling `reference:` earns one finding, not two) |
| `reference-vault-link`        | warn    | `type: reference` entry whose body wikilinks resolve to another vault entry — a reference points outward only; analysis belongs in a card or note (asset embeds and unresolved targets exempt) |
| `ticket-outward-only`         | warn    | `type: ticket` entry with a body `[[...]]` wikilink — a ticket body must be repo-self-sufficient; restate the material inline or name a repo artifact (file, commit, symbol) instead (frontmatter `track:`/`requires:`/`project:` wikilinks exempt) |
| `broken-wikilink`             | error   | `[[target]]` does not resolve to any vault file or asset — in the body **and** in YAML frontmatter (`key: "[[X]]"`), one dedup per file across both surfaces. Frontmatter targets are read from string scalars only, so a sequence value is never a link target and a nested array `key: [[a, b]]` cannot be misread as a link |
| `unquoted-frontmatter-link`   | warn    | `[[...]]` written unquoted in frontmatter (`key: [[X]]`), which YAML parses as a nested sequence rather than a string — the link becomes invisible to the backlink index and to every link rule, so it is a quoting fault, not a resolution one (fix: quote it, `key: "[[X]]"`) |
| `duplicate-h1`                | warn    | First non-blank body line is `# <basename>`, duplicating the implicit page title. |
| `callout-missing-separator`   | warn    | Callout's `[!Type]` header line and body sit in one paragraph — `autoformat`'s `proseWrap: never` joins them, Obsidian reads the joined text as the title, and the body disappears on render (fix: a blank `>` line between header and body) |
| `invalid-frontmatter`         | error   | YAML frontmatter fails to parse |
| `untagged-card`               | warn    | Card with missing or empty `tags:` array |
| `missing-required-field`      | warn    | File missing a required frontmatter field for its `type:` (one finding per field) |
| `unknown-field`               | warn    | Frontmatter key outside the schema its type's template declares — the template is the authority on which fields a type carries, so a stray key is a typo or a rename that skipped its entries (a type with no template has no schema and is never flagged; a universal meta-set — `created`, `updated`, `related`, `aliases`, the supersession keys — is legal on every type) |
| `invalid-enum-value`          | warn    | Frontmatter picker field whose string value is outside the option list its type's template declares (an empty, null, or multi-valued value reads as unfilled or non-picker rather than wrong, and a type with no template is never flagged) |
| `singleton-tag`               | warn    | Tag appearing in exactly one file (typo heuristic) |
| `singleton-filename-mismatch` | warn    | `type: context`/`type: scratchpad` entry not named `Context.md`/`Scratchpad.md` — a project holds one of each, and `vault-query context` reaches it by joining that constant onto the project path, so a misnamed one is never found (templates, superseded entries, and untyped files exempt) |
| `slug-filename-mismatch`      | warn    | `type: ticket`/`type: track` entry whose filename is not `<type>-<slug>` — queries resolve a track by filename stem, so a disagreement makes it unreachable by the slug it declares (templates, superseded entries, and entries with no `slug:` exempt) |
| `filename-hygiene`            | warn    | Basename carries a smart quote, a double space, or a trailing space before `.md` — typing accidents rather than naming choices, checked on every file regardless of `type:` |
| `unintended-emphasis`         | warn    | Emphasis run whose `*`/`_` delimiters read as literal text — two globs paired into italic (`src/*.ts and dist/*.js`), a doubled-underscore identifier (`__init__`), or a fill-in blank (`[__G0__]`). Obsidian already renders it as emphasis, and `autoformat` then normalizes the pair, rewriting the delimiters (fix: escape them as `\*`/`\_`, or move the text into a code span) |
| `unknown-rel`                 | warn    | `<rel>` relation token outside the known registry (typo heuristic; can be promoted into the registry) |
| `oversized-entry`             | warn    | Card/note/experiment/ticket body exceeds consult's per-doc token cap (templates and superseded entries exempt) |
| `untyped-entry`               | warn    | File with no `type:` frontmatter field (templates, superseded entries, and checkpoints exempt) |

## Excluding files

Two paths are always excluded regardless of any user configuration: `.git` and `.vaultignore`. These defaults cannot be disabled.

Users add further exclusions in `<vault_root>/.vaultignore`. Vault loads this file once per invocation. There are no nested ignore files.

Syntax: one vault-relative path prefix per line, `/` separators. Lines starting with `#` are comments. Blank lines are ignored. A trailing `/` is optional and normalized away.

```
# Tooling and scratch
.claude/
.claude-plans/

# Single file
20 cards/draft.md
```

Matching is path-component-aware. The pattern `.claude` matches `.claude/foo.md` and all descendants. It does not match `.claude-plans/foo.md`: the boundary falls at a component separator, so a shared string prefix to a sibling is safe.

Pass `--no-ignore` to suppress the user file. The built-in defaults (`.git` and `.vaultignore`) remain active. The flag is global and works on every `vault-query` subcommand.

```sh
vault-query lint --no-ignore           # see findings across all files (user file skipped; defaults still apply)
vault-query search "foo" --no-ignore   # search skips .vaultignore user file
```

**Backlink-graph effect.** Ignored files are invisible to lint's backlink index. A card that links to an ignored file still triggers `broken-wikilink`, because the target does not resolve in the visible file set. This is by design: excluding a file from lint means lint has no record of it as a valid link target.

## Tips

- **`broken-wikilink` defaults to `error`.** A bare `vault-query lint` exits 1 if the vault contains any broken wikilink. Override with `--rule broken-wikilink=warn` for a soft check, or set the severity in `~/.config/vault/config.json` under `lint.rules`.

- **`singleton-tag` defaults to `warn`.** It fires on tags used in exactly one file. Promote to `error` or demote to `off` via `--rule singleton-tag=<severity>` or via `lint.rules` in the root config.

- **`dangling-reference` does not check the wikilink target's `type:`.** A card with `reference: [[20 cards/Foo]]` (pointing at another card, not a `type: reference` file) suppresses the dangling check. The companion rules cover the misses: `reference-not-wikilink` when the `reference:` value is a non-wikilink string, `reference-wrong-type` when the wikilink resolves to a non-`reference` entry.

- **Act on findings interactively.** Use `/vault card <name>`, `/vault reference <name>`, or open the file directly to fix issues. Lint is read-only and never edits.

- **Severity layering.** Effective severity = root config (`~/.config/vault/config.json`'s `lint.rules` block) overridden key-by-key by `--rule` flags. Project config does not participate — lint is whole-vault.

## Exit code

- `0` — no `error`-severity findings.
- `1` — at least one `error`-severity finding (CI-friendly without parsing JSON).

## JSON shape

```json
[
  {
    "rule": "broken-wikilink",
    "severity": "error",
    "file": "20 cards/Foo.md",
    "message": "wikilink target 'path/to/Bar' does not resolve",
    "data": { "target": "path/to/Bar", "line": 12 }
  }
]
```

`file` is vault-relative. The top-level keys (`rule`, `severity`, `file`, `message`, `data`) are stable across rules. `data` is per-rule.

### `data` per rule

| Rule                          | `data` shape |
| ----------------------------- | ------------ |
| `orphan-card`                 | `null` |
| `dangling-reference`          | `null` |
| `dangling-relation-label`     | `{ "label": <string>, "position": "endpoint" or "from-label", "line": <number> }` |
| `dangling-requires-target`    | `{ "target": <string> }` |
| `reference-not-wikilink`      | `{ "value": <string> }` |
| `reference-wrong-type`        | `{ "target": <string>, "target_type": <string> }` |
| `reference-vault-link`        | `{ "target": <string>, "line": <number> }` |
| `ticket-outward-only`         | `{ "target": <string>, "line": <number> }` |
| `broken-wikilink`             | `{ "target": <string>, "line": <number> }` |
| `unquoted-frontmatter-link`   | `{ "target": <string>, "line": <number> }` |
| `duplicate-h1`                | `null` |
| `callout-missing-separator`   | `{ "line": <number>, "callout": <string> }` |
| `invalid-frontmatter`         | `{ "error": <string> }` |
| `untagged-card`               | `null` |
| `missing-required-field`      | `null` |
| `unknown-field`               | `null` |
| `invalid-enum-value`          | `null` |
| `singleton-tag`               | `{ "tag": <string> }` |
| `singleton-filename-mismatch` | `{ "type": <string>, "expected": <string> }` |
| `slug-filename-mismatch`      | `{ "slug": <string>, "expected": <string> }` |
| `filename-hygiene`            | `{ "issues": [<string>, ...] }` |
| `unintended-emphasis`         | `{ "line": <number>, "shape": <string>, "text": <string> }` |
| `unknown-rel`                 | `{ "rel": <string>, "line": <number> }` |
| `oversized-entry`             | `null` |
| `untyped-entry`               | `null` |

- `reference-not-wikilink.data.value` is the raw `reference:` frontmatter value that failed to parse as a wikilink (e.g. a bare URL).
- `broken-wikilink.data.target` is the **raw** wikilink target verbatim (including any path prefix). Call `wikilink::resolve_name` yourself if you want the bare note name. `broken-wikilink.data.line` is the 1-based source line of the offending `[[...]]`, counted over the whole file, so a frontmatter link and a body link are numbered on one scale. The `data` shape is the same either way; the `message` names the surface (`frontmatter wikilink target '…'` vs `wikilink target '…'`).
- `unquoted-frontmatter-link.data.target` is the text before any `|` inside the brackets; `data.line` is the 1-based file line the occurrence sits on. The `message` echoes the bracketed text verbatim, alias included.
- `singleton-tag.data.tag` is the tag string that appears in exactly one file across the corpus.
- `slug-filename-mismatch.data.slug` is the entry's declared `slug:`. `data.expected` is the basename it implies, without the `.md` extension.
- `singleton-filename-mismatch.data.type` is the entry's declared `type:`. `data.expected` is the basename that type reserves, without the `.md` extension. The two filename rules split the project folder's two populations: the many-per-project files are `<type>-<slug>` and lowercase, the one-per-project files are named for what they are and capitalized.
- `filename-hygiene.data.issues` lists every applicable kind found in the basename, drawn from `"smart-quote"`, `"double-space"`, `"trailing-space"` — a name can carry more than one at once, and all applicable kinds are listed rather than just the first detected.
- `invalid-frontmatter.data.error` is the raw YAML parse error message (e.g. `mapping values are not allowed in this context at line 4 column 28`).
- `dangling-relation-label.data.label` is the raw local endpoint or from-label string that resolved to no local node. `data.position` distinguishes `endpoint` from `from-label`, and `data.line` is the 1-based source line of the offending `## Relations` bullet.
- `dangling-requires-target.data.target` is the **raw** wikilink target verbatim (including any path prefix), matching `broken-wikilink.data.target`'s convention; frontmatter carries no line numbers, so this rule's `data` has no `line`.
- `unknown-rel.data.rel` is the `<rel>` token verbatim; `data.line` is the 1-based source line of the offending `## Relations` bullet.
- `callout-missing-separator.data.callout` is the `[!Type]` token verbatim (fold marker included, e.g. `[!note]-`); `data.line` is the 1-based source line of the callout's header.
