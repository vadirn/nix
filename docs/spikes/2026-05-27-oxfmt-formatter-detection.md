> **Superseded.** The iteration-2 design (manifest + `devDependencies`) described here was replaced by the `scripts["format:file"]` opt-in convention — see Decision 13 in `track-claude-code-tooling.md`. The production hook (`home/claude/hooks/post-tool-format.sh`) now reads `scripts["format:file"]` from `package.json` instead of probing `devDependencies`. The walk-up-with-inheritance shape is preserved; the formatter source changed. This document remains as the historical record of how the design evolved.

# Does marker-file detection in `post-tool-format.sh`, combined with skipping on `Edit`, eliminate version drift, Edit-round-trip breakage, and silent opinion imposition?

Date: 2026-05-27
Status: answered (with a redesign)
Time-box: 2h / ~1h45

## Method

The spike went through two iterations. Both shared the Edit-round-trip guard (`tool_name=Edit|MultiEdit → exit 0` in the JS/TS branch); the difference is how the project's formatter is identified.

**Iteration 1 — marker-file detection.** Walk up from the edited file looking for `biome.json` / `.prettierrc*` / `dprint.json` / `.oxfmtrc.json`. Route to the matching tool. Stop at `.git`. Captured at HEAD~ in `_spikes/oxfmt-formatter-detection/`. Passed a 19-case stub harness and an end-to-end real-`oxfmt` test via `bunx --bun oxfmt@0.52.0`.

**Iteration 2 — manifest + `devDependencies`.** Adopted after collision analysis flagged two problems with iteration 1: (a) outside a `.git` repo the walk could escape to `$HOME` and pick up a user-level `.prettierrc`, recreating the "silent opinion imposition" failure; (b) marker presence is not the same as formatter presence — a project with `prettier` pinned in `devDependencies` but no `.prettierrc` was skipped. The redesigned candidate:

1. Skips `Edit`/`MultiEdit` for the JS/TS branch (round-trip prevention).
2. Walks up for a project manifest (`package.json`, `deno.json`, `deno.jsonc`). Stop conditions: manifest found, `.git` root, `$HOME` boundary, filesystem root.
3. For `package.json`: reads `devDependencies` and `dependencies` via `jq`. Picks `@biomejs/biome` > `prettier` > `dprint`. Falls back to global `oxfmt` when the manifest declares no JS formatter.
4. For `deno.json` / `deno.jsonc`: runs `deno fmt` on the file.
5. No manifest → no formatting. Scratch directories and vendored libraries stay untouched.
6. For each formatter, prefers `./node_modules/.bin/<bin>` over the global binary.

Tested with a stub harness (`_spikes/oxfmt-formatter-detection/run-tests.sh`): four fake formatters (biome, prettier, dprint, deno) that record their invocation in a log, plus a `install_local_bin` helper that drops a tagged shim into `<root>/node_modules/.bin/<bin>` so we can distinguish the local-bin path from the global PATH route. 21 fixture cases. Result: **28/28 assertions pass**.

Real-world end-to-end via a `bunx --bun oxfmt@0.52.0` shim:

- `package.json` with `{ "devDependencies": { "typescript": "^5" } }` (no formatter declared) → oxfmt fallback formatted a messy `.ts` file in 32ms.
- No `package.json` at all → no formatting, file unchanged.
- The `tool_name=Edit` short-circuit produced no output and no file change (verified in iteration 1's run; structure is identical in iteration 2).

Cut corners: the harness does not exercise real biome/prettier/dprint binaries; only the routing into them and the local-bin preference are stub-verified. The real Edit-round-trip is a Claude-host interaction, not reproducible in shell — the structural guard is what the harness verifies.

## Result

| Failure mode (Backlog 1) | Candidate behaviour | Evidence |
| --- | --- | --- |
| Version drift (global `oxfmt@0.52.0` vs project's pinned formatter) | Defers to the project's declared formatter; uses local `node_modules/.bin/<bin>` first, then global | Cases c17 (local-bin precedence), c2–c4 (formatter identity from manifest), c21 (also reads `dependencies`) |
| Edit-round-trip (formatter reflows file between two Edits in one turn) | Returns 0 immediately for `Edit` and `MultiEdit`; formatter never runs on those tool calls | Cases c7, c8 |
| Silent opinion imposition (oxfmt silently reformats with defaults on every JS/TS file) | Only runs `oxfmt` when a `package.json` exists *and* declares no other formatter — the project has explicitly opted in to "JS project, no formatter pinned" | Cases c1 (no manifest → skipped), c5 (manifest without formatter → oxfmt fallback), c20 (minimal manifest → oxfmt fallback) |

Additional properties confirmed by the harness:

- Manifest precedence: biome > prettier > dprint > oxfmt-fallback (c6)
- Walks up from nested files (c9)
- Stops at `.git` root (c10)
- Stops at `$HOME` boundary (c11)
- Honours both `devDependencies` and `dependencies` fields (c21)
- Monorepo: sub-package's manifest wins over root (c19)
- `deno.json` projects route to `deno fmt` (c18)
- `tsconfig.json` inside a biome project gets formatted; in a bare directory it stays untouched, comments and trailing commas preserved (c12, c13)
- Survives missing `file_path` (c15) and missing routed binary (c16)

Harness output:

```
PASS  c1 no manifest: file unchanged
PASS  c1 no manifest: log empty
...
PASS  c21 dependencies field: prettier detected

----- summary -----
PASS: 28
FAIL: 0
```

## Decision

Proceed with iteration 2: replace the JS/TS branch in `home/claude/hooks/post-tool-format.sh` with the manifest + `devDependencies` logic. Iteration 1's marker-file approach is discarded.

## Next step

Port the candidate's JS/TS branch into `home/claude/hooks/post-tool-format.sh`, then resolve Backlog 2–7 in order (rebuild → smoke-test → live-fire verification).

---

## Surface findings worth recording

1. **`oxfmt` requires valid JSON config when `.oxfmtrc.json` is present.** An empty `.oxfmtrc.json` makes oxfmt error with `EOF while parsing a value at line 1 column 0` and refuse to format. Iteration 2 sidesteps this — it no longer treats `.oxfmtrc.json` as a marker — but a project that does add the file must put at least `{}` in it.
2. **`tsconfig.json` JSONC survives oxfmt.** Resolves Backlog (6). oxfmt 0.52.0 preserves `// comments` and normalises trailing commas; TypeScript accepts both forms, so the change is benign.
3. **`oxfmt --silent` does not exist in 0.52.0.** The "No config found, using defaults" warning will appear once per invocation when running the oxfmt fallback. Acceptable noise — the user opted in by having `package.json` without a formatter declared.
4. **Collision posture.** The hook produces the same output as the project's `npm run format` for the common case (single formatter via standard config), at the cost of ~50ms duplicated work if the user also has editor format-on-save. Documented in the spike README. Custom `format` scripts that chain ESLint or codemods are not honoured — the hook formats only; lint-fix passes belong in CI or a separate hook.

## Capture checks

**Confidence:** 8. Biggest risk that could lower this grade: the real Edit-round-trip is not observable in a shell harness, so the fix is verified by structure (skip on `tool_name=Edit`) rather than by reproducing the failure end-to-end.

**Falsification:** Conclusion is falsified if, after porting, an `Edit` in a JS project still triggers a format pass (means `tool_name` isn't being passed by the hook event as assumed). Branches the prototype did not exercise: real biome/prettier/dprint binaries invoked end-to-end; symlinked project roots; manifests inside `node_modules/`; projects that pin a formatter in a workspace root's `package.json` but expect sub-packages to inherit it (the current walk picks the sub-package's manifest, which may not declare the formatter — would fall back to oxfmt unexpectedly).

**Prose polish:** Applied — active voice, no filler.

**Reasoning chain:** Thesis: manifest + devDependencies detection plus Edit-skip resolves all three failure modes. Premises: (a) `tool_name` in the PostToolUse JSON payload is `Edit` for `Edit` tool calls — grounded in the existing PreToolUse hooks that read the same field; (b) `devDependencies` / `dependencies` accurately reflect which formatter the project uses — grounded in how the JS ecosystem ships formatter pins; (c) `package.json` is a reliable project boundary — grounded in npm/yarn/pnpm/bun all treating it that way. All three premises are grounded.

**Open gap acknowledged in falsification:** workspace-root formatter pinned for sub-packages. If this turns out to be common in this repo's downstream use, extend the walk to continue past a sub-package's `package.json` when it has no formatter, until one is found or `.git` is reached.
