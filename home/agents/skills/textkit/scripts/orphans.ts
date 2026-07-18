#!/usr/bin/env bun
// Dead-file lint: reports modules under src/ that nothing imports.
//
// This exists because package.json declares `"exports": {"./*": "./src/*"}` so the
// `textkit/*` alias resolves from any cwd (see tsconfig paths and the bin/ wrappers).
// That wildcard makes every file under src/ public API, and knip treats public API as
// entry files — entry files are never "unused", so knip's own unused-files check goes
// silent. It still reports unused *exports* (knip.json sets includeEntryExports), so
// this script covers the other half: files nothing reaches.
//
// madge already ships for the `cycles` script and computes the import graph, so the
// orphan set comes from `madge --orphans --json` rather than a second parser.
//
// One exemption: *.test.ts — the test runner is their entry point, not an import.
// ALLOWED covers standalone scripts run directly by path, which have no importer by
// design; it is empty today (the g4 calibration harness that held the only entry was
// deleted once its result was recorded in the track).

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Standalone modules run by path, so no importer exists by design. */
const ALLOWED = new Set<string>();

const proc = Bun.spawnSync(
  [
    "bunx",
    "madge",
    "--orphans",
    "--extensions",
    "ts",
    "--ts-config",
    "tsconfig.json",
    "src",
    "--json",
  ],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);

if (proc.exitCode !== 0) {
  console.error(proc.stderr.toString().trim());
  console.error("orphans: madge failed");
  process.exit(1);
}

const orphans = JSON.parse(proc.stdout.toString()) as string[];
const dead = orphans.filter((f) => !f.endsWith(".test.ts") && !ALLOWED.has(f));

if (dead.length > 0) {
  for (const f of dead) console.error(`src/${f}`);
  console.error(`\norphans: ${dead.length} unreferenced file(s)`);
  process.exit(1);
}

console.log("orphans: OK — every src file is reachable");
process.exit(0);
