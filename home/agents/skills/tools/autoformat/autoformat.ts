#!/usr/bin/env bun
/**
 * autoformat — normalize files with whatever formatter their extension calls
 * for. One entry point for the terminal and for the agent, which is reminded
 * of it after every Write/Edit by home/claude/hooks/hint-autoformat.sh.
 *
 * Nothing formats behind the agent's back: it decides when files change, so a
 * reflow can never land between two Edits and break the second one's
 * old_string. That race is what the retired queue-format/flush-format-queue
 * hook pair existed to dodge.
 *
 * Routing by extension:
 *   ts tsx js jsx mjs cjs json jsonc md html css
 *         nearest ancestor package.json defining a `format:file` script
 *         (convention: takes one path, formats it in place), run via the
 *         detected package manager from the manifest's dir > `deno fmt` at the
 *         nearest deno root > oxfmt. The walk is bounded by .git, $HOME, or /.
 *         A package.json without `format:file` does NOT end the walk —
 *         workspace-root scripts are inherited.
 *   py    ruff check --fix, then ruff format
 *   nix   alejandra
 *   rs    rustfmt
 *   *     ignored
 *
 * oxfmt's config is always passed explicitly with -c: its own discovery walks
 * up from the cwd and stops at a .git boundary, which answers a question about
 * the caller's location rather than the file's. Resolved per file: nearest
 * .oxfmtrc.json between the file and its repo root, else ~/.oxfmtrc.json
 * (proseWrap: never — markdown paragraphs stay on one line; other filetypes
 * take oxfmt's defaults).
 *
 * Selection:
 *   autoformat PATH...   files are formatted, directories are walked
 *   autoformat           inside a git work tree: the files git reports as
 *                        modified or untracked. Elsewhere: walks the cwd.
 *   autoformat -a        walks the cwd whatever git says — the escape hatch
 *                        for a repo that gitignores what you edit.
 *   autoformat ./-a      a leading ./ never starts with a dash, so this is the
 *                        escape hatch for a path named -a.
 *   autoformat . -- -a   -- also ends option parsing, but bun swallows a --
 *                        sitting directly after the script path in every
 *                        invocation form, so it only works once another
 *                        argument precedes it.
 *
 * Files sharing a formatter are handed to it in one invocation, so a walk of a
 * large tree spawns a handful of processes rather than one per file. Formatter
 * output surfaces only on failure.
 *
 * A run is a pipeline, one function per stage: parseArgs, selectFiles,
 * routeFiles, planJobs, runJobs, report.
 *
 * Exit 0 when every formatter that ran succeeded, 1 when one failed or a named
 * path is missing, 2 on a usage error. An absent formatter and a directory the
 * walk could not read are both reported on stderr and neither is an error:
 * coverage was incomplete, but nothing that ran went wrong.
 *
 * Standalone by design: no imports beyond node builtins, no runtime
 * dependencies, no build step. It is a member of the home/agents/skills bun
 * workspace only to inherit that workspace's pinned typecheck, lint, and test;
 * its package.json declares no dependencies, because ~/.local/bin/autoformat
 * (see home/default.nix) symlinks this file itself and runs it under the
 * shebang above — a dependency would make the CLI need an installed
 * node_modules to start.
 *
 * That symlink is out-of-store (mkOutOfStoreSymlink), pointed straight at
 * this source file rather than a build artifact — unlike the compiled Rust
 * CLIs this repo also ships (mdstruct, vault-query), an edit here is live
 * the moment it is saved. No ./rebuild.sh needed to pick it up.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HOME = homedir();
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  "result",
  "vendor",
  ".direnv",
  ".venv",
  "__pycache__",
]);
const WEB_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "jsonc",
  "md",
  "html",
  "css",
]);
// vault-archive holds write-once, content-hash-addressed source snapshots
// (frozen provenance): reflowing one silently diverges the stored bytes from
// the hash recorded on its reference stub.
const FROZEN = join(HOME, "Documents", "vault-archive") + "/";

const USAGE = `usage: autoformat [-a] [--] [PATH...]

  PATH...  files are formatted, directories are walked
  (none)   git-modified + untracked files in the current work tree,
           or a walk of the cwd when outside one
  -a       walk the cwd instead of asking git
  ./-a     escape hatch for a path starting with a dash (./ never does)
  --       also ends option parsing, but only once another argument
           precedes it — bun swallows a -- right after the script path`;

type Run = { ok: boolean; output: string };

async function run(cmd: string[], cwd: string): Promise<Run> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  // Untrimmed on purpose: a `git status --porcelain` entry opens with its
  // status column, and " M path" would lose it to a trim.
  return { ok: code === 0, output: out + err };
}

/** Package manager for a project dir, by lockfile precedence. */
function detectPm(dir: string): string {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Directories from a file up to its repo root (inclusive of both ends). */
function* ancestors(file: string): Generator<string> {
  let dir = dirname(resolve(file));
  for (;;) {
    yield dir;
    if (existsSync(join(dir, ".git")) || dir === HOME || dir === "/") return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

type WebTool =
  | { tool: "format:file"; root: string }
  | { tool: "deno"; root: string }
  | { tool: "oxfmt"; config: string };

function hasFormatFile(manifest: string): boolean {
  try {
    return Boolean(JSON.parse(readFileSync(manifest, "utf8"))?.scripts?.["format:file"]);
  } catch {
    // An unparsable manifest defines no formatter; keep walking.
    return false;
  }
}

function resolveWebTool(file: string): WebTool {
  let sawPkg = false;
  for (const dir of ancestors(file)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      if (hasFormatFile(pkg)) return { tool: "format:file", root: dir };
      // A package.json without format:file does not end the walk —
      // workspace-root scripts are inherited — but it does rule out deno.
      sawPkg = true;
    } else if (
      !sawPkg &&
      (existsSync(join(dir, "deno.json")) || existsSync(join(dir, "deno.jsonc")))
    ) {
      return { tool: "deno", root: dir };
    }
  }
  return { tool: "oxfmt", config: oxfmtConfig(file) };
}

/** Nearest .oxfmtrc.json between the file and its repo root, else the global one. */
function oxfmtConfig(file: string): string {
  for (const dir of ancestors(file)) {
    const local = join(dir, ".oxfmtrc.json");
    if (existsSync(local)) return local;
  }
  return join(HOME, ".oxfmtrc.json");
}

/**
 * Walk `dir`, adding every file under it to `into`. A directory that refuses
 * to be read is a hole in the walk, so its message lands in `walkErrors`
 * rather than letting the files inside vanish unmentioned.
 */
function collectDir(dir: string, into: Set<string>, walkErrors: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const why = (err as { code?: string })?.code ?? String(err);
    walkErrors.push(`autoformat: cannot read ${dir}: ${why}`);
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectDir(full, into, walkErrors);
    } else if (entry.isFile()) {
      addFile(full, into);
    }
  }
}

function addFile(file: string, into: Set<string>): void {
  const abs = resolve(file);
  if (abs.startsWith(FROZEN)) return;
  into.add(abs);
}

/**
 * Files git reports as modified or untracked, absolute. -z is the only
 * porcelain form that never quotes a path, and the vault's directory names
 * carry spaces. A rename entry emits a second field (the old path) that is
 * read and dropped; deleted paths fall out on the existence check.
 */
async function gitDirty(into: Set<string>): Promise<string | null> {
  const top = await run(["git", "rev-parse", "--show-toplevel"], process.cwd());
  if (!top.ok) return null;
  const root = top.output.trim();
  const status = await run(
    ["git", "-C", root, "status", "--porcelain", "-z", "--untracked-files=all"],
    root,
  );
  if (!status.ok) return root;
  const fields = status.output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes("R") || code.includes("C")) i++;
    const full = join(root, path);
    if (existsSync(full) && statSync(full).isFile()) addFile(full, into);
  }
  return root;
}

function ext(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

type Args = { all: boolean; named: string[] };

/**
 * Options and paths, or the exit code of a run that ends in parsing (--help,
 * an unknown option). Everything after -- is a path, dash or no dash.
 */
function parseArgs(argv: string[]): Args | number {
  let all = false;
  let options = true;
  const named: string[] = [];
  for (const arg of argv) {
    if (!options || !arg.startsWith("-")) {
      named.push(arg);
    } else if (arg === "--") {
      options = false;
    } else if (arg === "-a" || arg === "--all") {
      all = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return 0;
    } else {
      console.error(`autoformat: unknown option: ${arg}`);
      console.error(USAGE);
      return 2;
    }
  }
  return { all, named };
}

type Selection = {
  files: Set<string>;
  /** Repo root when git chose the files — the empty summary names it. */
  gitRoot: string | null;
  /** Ready-to-print messages for directories the walk could not read. */
  walkErrors: string[];
  /** Named paths that do not exist. */
  notFound: string[];
};

/** The files to format: the named paths, or git's answer, or a walk of the cwd. */
async function selectFiles({ all, named }: Args): Promise<Selection> {
  const files = new Set<string>();
  const walkErrors: string[] = [];
  const notFound: string[] = [];
  let gitRoot: string | null = null;

  if (named.length === 0) {
    if (all) collectDir(process.cwd(), files, walkErrors);
    else {
      gitRoot = await gitDirty(files);
      if (gitRoot === null) collectDir(process.cwd(), files, walkErrors);
    }
  } else {
    for (const path of named) {
      if (!existsSync(path)) {
        console.error(`autoformat: no such file or directory: ${path}`);
        notFound.push(path);
      } else if (statSync(path).isDirectory()) collectDir(path, files, walkErrors);
      else addFile(path, files);
    }
  }

  return { files, gitRoot, walkErrors, notFound };
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const batch = map.get(key);
  if (batch) batch.push(value);
  else map.set(key, [value]);
}

/** Files grouped by the formatter each one calls for. */
type Routes = {
  oxfmtByConfig: Map<string, string[]>;
  denoByRoot: Map<string, string[]>;
  formatFile: { root: string; file: string }[];
  py: string[];
  nix: string[];
  rs: string[];
};

/**
 * Group by formatter so each one runs once over many files. format:file is
 * the exception: the convention is one path per call.
 */
function routeFiles(files: Set<string>): Routes {
  const routes: Routes = {
    oxfmtByConfig: new Map(),
    denoByRoot: new Map(),
    formatFile: [],
    py: [],
    nix: [],
    rs: [],
  };
  for (const file of [...files].sort()) {
    const e = ext(file);
    if (WEB_EXTS.has(e)) {
      const target = resolveWebTool(file);
      if (target.tool === "format:file") routes.formatFile.push({ root: target.root, file });
      else if (target.tool === "deno") push(routes.denoByRoot, target.root, file);
      else push(routes.oxfmtByConfig, target.config, file);
    } else if (e === "py") routes.py.push(file);
    else if (e === "nix") routes.nix.push(file);
    else if (e === "rs") routes.rs.push(file);
  }
  return routes;
}

/**
 * One formatter invocation. `files` is the batch it rewrites; `credit` says
 * whether the summary counts that batch against `tool`, and is false for a
 * follow-up pass over files a previous job already counted (ruff format after
 * ruff check). `cwd` is "/" wherever every path is absolute and every config
 * explicit, so a stale working directory cannot change the outcome.
 */
type Job = { tool: string; files: string[]; credit: boolean; cwd: string; cmd: string[] };

/** Jobs to run, plus how many files each absent formatter left untouched. */
type Plan = { jobs: Job[]; missing: Map<string, number> };

function planJobs(routes: Routes): Plan {
  const jobs: Job[] = [];
  const missing = new Map<string, number>();
  const need = (tool: string, count: number): boolean => {
    if (Bun.which(tool)) return true;
    missing.set(tool, (missing.get(tool) ?? 0) + count);
    return false;
  };

  for (const [config, files] of routes.oxfmtByConfig) {
    if (need("oxfmt", files.length)) {
      jobs.push({
        tool: "oxfmt",
        files,
        credit: true,
        cwd: "/",
        cmd: ["oxfmt", "-c", config, ...files],
      });
    }
  }
  for (const [root, files] of routes.denoByRoot) {
    if (need("deno", files.length)) {
      jobs.push({
        tool: "deno",
        files,
        credit: true,
        cwd: root,
        cmd: ["deno", "fmt", ...files],
      });
    }
  }
  for (const { root, file } of routes.formatFile) {
    const pm = detectPm(root);
    if (!need(pm, 1)) continue;
    // npm needs `--` to forward args to the script; bun/pnpm/yarn do not.
    const cmd =
      pm === "npm" ? ["npm", "run", "format:file", "--", file] : [pm, "run", "format:file", file];
    jobs.push({ tool: "format:file", files: [file], credit: true, cwd: root, cmd });
  }
  const { py, nix, rs } = routes;
  if (py.length && need("ruff", py.length)) {
    jobs.push({
      tool: "ruff",
      files: py,
      credit: true,
      cwd: "/",
      cmd: ["ruff", "check", "--fix", "--quiet", ...py],
    });
    jobs.push({
      tool: "ruff",
      files: py,
      credit: false,
      cwd: "/",
      cmd: ["ruff", "format", "--quiet", ...py],
    });
  }
  if (nix.length && need("alejandra", nix.length)) {
    jobs.push({
      tool: "alejandra",
      files: nix,
      credit: true,
      cwd: "/",
      cmd: ["alejandra", "--quiet", ...nix],
    });
  }
  if (rs.length && need("rustfmt", rs.length)) {
    jobs.push({
      tool: "rustfmt",
      files: rs,
      credit: true,
      cwd: "/",
      // Standalone rustfmt defaults to edition 2015; this workspace is
      // edition = "2024" (Cargo.toml), so the flag is required or modern
      // syntax misparses.
      //
      // --config skip_children=true keeps rustfmt from following `mod`
      // declarations into sibling files it was never given — without it,
      // formatting one file (e.g. a lib.rs declaring a dozen modules)
      // silently reflows every one of them, which is exactly the
      // behind-the-back rewrite this module's header claims can't happen.
      // It also stops one unresolvable `mod` (a path that doesn't exist on
      // disk) from failing the whole batch. The bare `--skip-children` flag
      // is rejected by rustfmt; it must go through `--config`.
      cmd: ["rustfmt", "--edition", "2024", "--config", "skip_children=true", ...rs],
    });
  }

  return { jobs, missing };
}

type Outcome = { done: Map<string, number>; failed: boolean };

/** Run every job, reporting the output of the ones that fail. */
async function runJobs(jobs: Job[]): Promise<Outcome> {
  const done = new Map<string, number>();
  let failed = false;
  for (const job of jobs) {
    const result = await run(job.cmd, job.cwd);
    if (!result.ok) {
      console.error(`autoformat: ${job.tool} failed`);
      if (result.output.trim()) console.error(result.output.trim());
      failed = true;
      continue;
    }
    if (job.credit) done.set(job.tool, (done.get(job.tool) ?? 0) + job.files.length);
  }
  return { done, failed };
}

type Report = {
  done: Map<string, number>;
  missing: Map<string, number>;
  walkErrors: string[];
  gitRoot: string | null;
};

/** What was formatted on stdout; what the run could not reach on stderr. */
function report({ done, missing, walkErrors, gitRoot }: Report): void {
  const summary = [...done]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, count]) => `${tool} ${count}`)
    .join(", ");

  if (summary) console.log(`autoformat: ${summary}`);
  else if (gitRoot) {
    console.log(
      `autoformat: nothing to format in ${gitRoot} — git-ignored edits need explicit paths or -a`,
    );
  } else console.log("autoformat: nothing to format");

  for (const line of walkErrors) console.error(line);
  for (const [tool, count] of [...missing].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`autoformat: ${tool} not found, skipped ${count} file(s)`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "number") return args;

  const { files, gitRoot, walkErrors, notFound } = await selectFiles(args);
  const { jobs, missing } = planJobs(routeFiles(files));
  const { done, failed } = await runJobs(jobs);
  report({ done, missing, walkErrors, gitRoot });

  return failed || notFound.length > 0 ? 1 : 0;
}

process.exit(await main());
