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

1. Write the pattern against three sample files copied to `/tmp/codemod-samples/`.
2. Run with `--dry` (or ast-grep without `-U`) and diff against expected output.
3. Once samples pass, run across one directory at a time. Commit per directory.
4. After each directory commit, run the project's verify entrypoint (`bun run verify`, `make verify`, or `./scripts/verify.sh`, depending on what the project defines).
5. Document any files the codemod could not handle. Edit those manually in a separate commit.

## Anti-patterns

- Running the codemod across the whole tree in one pass: review becomes impossible.
- Skipping the sample step: hidden edge cases land in real code.
- Using regex instead of an AST tool: false positives in strings and comments.
