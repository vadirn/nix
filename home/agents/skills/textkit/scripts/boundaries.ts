#!/usr/bin/env bun
// Boundary lint: enforces the slice contract across src/.
//
// Slices are the four first path segments under src/: core | distill | polish | cards.
// Everything else — files directly under src/ (e.g. *.test.ts), src/experiment/**,
// src/fixtures/** — is UNCLASSIFIED and exempt as an importer (tests and experiments
// may reach into anything).
//
// Rules on a classified importer's `#src/<seg>/...` specifiers:
//   1. A cross-slice import (importer slice != imported slice) is allowed only when the
//      imported slice is "core".
//   2. One exception: a file under cards/** may import "#src/distill/emit" (and no other
//      "#src/distill/..." path).
//
// Import specifiers are read with Bun.Transpiler().scanImports(), which parses each file
// and returns only real import/require/dynamic-import specifiers — so `import`/`from`
// text inside comments or strings never registers, and a specifier reflowed onto its own
// line is still bound to its import. The alias prefix and src dir come from tsconfig's
// compilerOptions.paths, not baked-in assumptions. Dependency-free: bun + node:fs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SLICES = new Set(["core", "distill", "polish", "cards"]);
const ROOT = join(import.meta.dir, "..");

/**
 * Derive the alias prefix and src directory from tsconfig compilerOptions.paths.
 * Expects a single `#src/* -> ./src/*` style entry: the key without its `*` is the
 * specifier prefix, the target without `./` and `*` is the src dir.
 */
function resolveAlias(): { prefix: string; srcRel: string } {
  const cfg = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
  const paths = cfg.compilerOptions?.paths ?? {};
  const entry = Object.entries(paths)[0] as [string, string[]] | undefined;
  if (!entry) throw new Error("tsconfig compilerOptions.paths has no alias entry");
  const [key, targets] = entry;
  const prefix = key.replace(/\*$/, ""); // "#src/*" -> "#src/"
  const srcRel = targets[0]!.replace(/^\.\//, "").replace(/\*$/, "").replace(/\/$/, ""); // "./src/*" -> "src"
  return { prefix, srcRel };
}

const { prefix: ALIAS, srcRel: SRC_REL } = resolveAlias();
const SRC = join(ROOT, SRC_REL);

/** Classify a src-relative path by its first segment; null when UNCLASSIFIED. */
function sliceOf(relPath: string): string | null {
  const seg = relPath.split("/")[0];
  return seg && SLICES.has(seg) ? seg : null;
}

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts"];

/** Walk src/ and collect every TypeScript source file (absolute paths). */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTS.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });

/** Pick a transpiler whose loader matches the file extension (.tsx needs the JSX loader). */
function transpilerFor(name: string): Bun.Transpiler {
  return name.endsWith(".tsx") ? tsxTranspiler : tsTranspiler;
}

/** Best-effort line for a specifier, for reporting only (scanImports carries no position). */
function lineOf(lines: string[], spec: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(`"${spec}"`) || lines[i]!.includes(`'${spec}'`)) return i + 1;
  }
  return 0;
}

type Violation = { file: string; line: number; spec: string };

const violations: Violation[] = [];

for (const abs of walk(SRC)) {
  const rel = relative(SRC, abs);
  const importerSlice = sliceOf(rel);
  if (importerSlice === null) continue; // UNCLASSIFIED importers are exempt.

  const raw = readFileSync(abs, "utf8");
  // scanImports throws on a leading `#!/usr/bin/env bun` shebang (CLI entrypoints
  // carry one); blank that first line so line numbers still line up for reporting.
  const src = raw.startsWith("#!") ? raw.replace(/^[^\n]*/, "") : raw;
  const lines = src.split("\n");
  for (const imp of transpilerFor(abs).scanImports(src)) {
    const spec = imp.path; // e.g. "#src/distill/emit.ts"
    if (!spec.startsWith(ALIAS)) continue; // not an aliased internal import
    const rest = spec.slice(ALIAS.length); // drop the alias prefix, e.g. "#src/"
    const importedSlice = rest.split("/")[0]!;
    if (!SLICES.has(importedSlice)) continue; // not a slice-classified import
    if (importedSlice === importerSlice) continue; // same slice: always fine
    if (importedSlice === "core") continue; // rule 1: core is the shared floor

    // rule 2: the single cards/** -> #src/distill/emit exception.
    const isEmitException =
      importerSlice === "cards" &&
      importedSlice === "distill" &&
      /^distill\/emit(\.ts)?$/.test(rest);
    if (isEmitException) continue;

    violations.push({ file: rel, line: lineOf(lines, spec), spec });
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
