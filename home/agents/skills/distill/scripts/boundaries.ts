#!/usr/bin/env bun
// Boundary lint: enforces the slice contract across src/.
//
// Slices are the four first path segments under src/: core | distill | polish | cards.
// Everything else — files directly under src/ (e.g. *.test.ts), src/experiment/**,
// src/fixtures/** — is UNCLASSIFIED and exempt as an importer (tests and experiments
// may reach into anything).
//
// Rules on a classified importer's `@/<seg>/...` specifiers:
//   1. A cross-slice import (importer slice != imported slice) is allowed only when the
//      imported slice is "core".
//   2. One exception: a file under cards/** may import "@/distill/emit" (and no other
//      "@/distill/..." path).
//
// All internal imports are `@/`-aliased (tsconfig paths), so specifiers are parsed
// directly — no module resolver or madge needed. Dependency-free: bun + node:fs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SLICES = new Set(["core", "distill", "polish", "cards"]);
const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "src");

/** Classify a src-relative path by its first segment; null when UNCLASSIFIED. */
function sliceOf(relPath: string): string | null {
  const seg = relPath.split("/")[0];
  return seg && SLICES.has(seg) ? seg : null;
}

/** Walk src/ and collect every *.ts file (absolute paths). */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Matches both static `from "@/..."` and dynamic `import("@/...")` specifiers.
const IMPORT_RE = /(?:from|import)\s*\(?\s*["'](@\/[^"']+)["']/g;

type Violation = { file: string; line: number; spec: string };

const violations: Violation[] = [];

for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs);
  const importerSlice = sliceOf(rel);
  if (importerSlice === null) continue; // UNCLASSIFIED importers are exempt.

  const src = readFileSync(abs, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(line)) !== null) {
      const spec = m[1]!; // e.g. "@/distill/emit.ts"
      const rest = spec.slice(2); // drop "@/"
      const importedSlice = rest.split("/")[0]!;
      if (!SLICES.has(importedSlice)) continue; // not a slice-classified import
      if (importedSlice === importerSlice) continue; // same slice: always fine
      if (importedSlice === "core") continue; // rule 1: core is the shared floor

      // rule 2: the single cards/** -> @/distill/emit exception.
      const isEmitException =
        importerSlice === "cards" &&
        importedSlice === "distill" &&
        /^distill\/emit(\.ts)?$/.test(rest);
      if (isEmitException) continue;

      violations.push({ file: rel, line: i + 1, spec });
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`src/${v.file}:${v.line} -> ${v.spec}`);
  }
  console.error(`\nboundaries: ${violations.length} violation(s)`);
  process.exit(1);
}

console.log("boundaries: OK — slice contract holds");
process.exit(0);
