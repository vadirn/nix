---
name: codemod
description: Codemod-first refactor pattern. Use when a refactor touches more than 20 files, when renaming across packages, when changing a function signature used everywhere, or when migrating between library versions.
---

# Codemod-first refactor

## Decision

If the change is mechanical and applies the same transform N times, write a codemod. Manual edits scale poorly past 20 files and accumulate inconsistencies.

## Tool choice

- **ast-grep**: first choice. Pattern matching by AST node, 20+ languages, no compile step.
- **jscodeshift**: when the transform needs JS/TS-specific AST APIs (type annotations, JSX, import reshuffling).

## Procedure

1. Write the pattern against three sample files copied to `$TMPDIR/codemod-samples/`.
2. Run with `--dry` (or ast-grep without `-U`) and diff against expected output.
3. Once samples pass, run across one directory at a time. Commit per directory.
4. After each directory commit, run the project's verify entrypoint. To find it: check `scripts` in `package.json` first, then `Makefile` targets, then `./scripts/` executables in that order. Use the first match (`bun run verify`, `make verify`, or `./scripts/verify.sh` are common names). If none found, run the project's test command and note the missing verify target as a gap.
5. Document any files the codemod could not handle. Edit those manually in a separate commit.

## Anti-patterns

- Run the codemod one directory at a time; a whole-tree pass makes review impossible.
- Complete the sample step; skipping it lets hidden edge cases reach real code.
- Use an AST tool; regex produces false positives in strings and comments.
