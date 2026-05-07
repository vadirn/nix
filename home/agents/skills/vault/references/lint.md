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

Run `vault-query lint` as a periodic vault health check, or before a vault-edit session, to surface structural issues: orphan cards, broken wikilinks, references not cited by any card, and similar.

The default output is text. Pipe `--format json` to `jq` for machine-readable processing; use `--format summary` to see counts per rule when triaging.

## Rules

| Rule                     | Default | What it flags                                                                     |
| ------------------------ | ------- | --------------------------------------------------------------------------------- |
| `orphan-card`            | warn    | Card with zero inbound wikilinks                                                  |
| `dangling-reference`     | warn    | Reference not cited by any card's `reference:` frontmatter                        |
| `reference-not-wikilink` | warn    | Card's `reference:` value is a non-wikilink string (e.g. raw URL)                 |
| `broken-wikilink`        | error   | `[[target]]` does not resolve to any vault file                                   |
| `invalid-frontmatter`    | error   | YAML frontmatter fails to parse                                                   |
| `untagged-card`          | warn    | Card with missing or empty `tags:` array                                          |
| `missing-required-field` | warn    | File missing a required frontmatter field for its `type:` (one finding per field) |
| `singleton-tag`          | warn    | Tag appearing in exactly one file (typo heuristic)                                |

## Excluding files

Two paths are always excluded regardless of any user configuration: `.git` and `.vaultignore`. These defaults cannot be disabled.

Users add further exclusions in `<vault_root>/.vaultignore`. Vault loads this file once per invocation; there are no nested ignore files.

Syntax: one vault-relative path prefix per line, `/` separators. Lines starting with `#` are comments; blank lines are ignored. A trailing `/` is optional and normalized away.

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

**Backlink-graph effect.** Ignored files are invisible to lint's backlink index. A card that links to an ignored file will still trigger `broken-wikilink`, because the target does not resolve in the visible file set. This is by design: excluding a file from lint means lint has no record of it as a valid link target.

## Tips

- **`broken-wikilink` defaults to `error`.** A bare `vault-query lint` exits 1 if the vault contains any broken wikilink. Override with `--rule broken-wikilink=warn` for a soft check, or set the severity in `~/.config/vault/config.json` under `lint.rules`.

- **`singleton-tag` defaults to `warn`.** It fires on tags used in exactly one file. Promote to `error` or demote to `off` via `--rule singleton-tag=<severity>` or via `lint.rules` in the root config.

- **`dangling-reference` does not check the wikilink target's `type:`.** A card with `reference: [[20 cards/Foo]]` (pointing at another card, not a `type: reference` file) suppresses the dangling check. The companion `reference-not-wikilink` rule covers the related miss where the `reference:` value is a non-wikilink string.

- **Act on findings interactively.** Use `/vault card <name>`, `/vault reference <name>`, or open the file directly to fix issues; lint is read-only and never edits.

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

`file` is vault-relative. The top-level keys (`rule`, `severity`, `file`, `message`, `data`) are stable across rules; `data` is per-rule.

### `data` per rule

| Rule                     | `data` shape                               |
| ------------------------ | ------------------------------------------ |
| `orphan-card`            | `null`                                     |
| `dangling-reference`     | `null`                                     |
| `reference-not-wikilink` | `{ "value": <string> }`                    |
| `broken-wikilink`        | `{ "target": <string>, "line": <number> }` |
| `invalid-frontmatter`    | `{ "error": <string> }`                    |
| `untagged-card`          | `null`                                     |
| `missing-required-field` | `null`                                     |
| `singleton-tag`          | `{ "tag": <string> }`                      |

- `reference-not-wikilink.data.value` is the raw `reference:` frontmatter value that failed to parse as a wikilink (e.g. a bare URL).
- `broken-wikilink.data.target` is the **raw** wikilink target verbatim (including any path prefix); call `wikilink::resolve_name` yourself if you want the bare note name. `broken-wikilink.data.line` is the 1-based source line of the offending `[[...]]`.
- `singleton-tag.data.tag` is the tag string that appears in exactly one file across the corpus.
- `invalid-frontmatter.data.error` is the raw YAML parse error message (e.g. `mapping values are not allowed in this context at line 4 column 28`).
