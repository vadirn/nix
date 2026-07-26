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
 *
 * Files sharing a formatter are handed to it in one invocation, so a walk of a
 * large tree spawns a handful of processes rather than one per file. Formatter
 * output surfaces only on failure.
 *
 * Exit 0 when every formatter that ran succeeded, 1 when one failed or a named
 * path is missing, 2 on a usage error. An absent formatter is reported in the
 * summary, not an error.
 *
 * Standalone by design: no imports beyond node builtins, no package.json, no
 * build step. Deployed as a ~/.local/bin symlink (see home/default.nix).
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

const USAGE = `usage: autoformat [-a] [PATH...]

  PATH...  files are formatted, directories are walked
  (none)   git-modified + untracked files in the current work tree,
           or a walk of the cwd when outside one
  -a       walk the cwd instead of asking git`;

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

function collectDir(dir: string, into: Set<string>): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectDir(full, into);
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

/**
 * One formatter invocation. `count` is what the summary credits to `tool`, and
 * is 0 for a follow-up pass over files a previous job already counted (ruff
 * format after ruff check). `cwd` is "/" wherever every path is absolute and
 * every config explicit, so a stale working directory cannot change the
 * outcome.
 */
type Job = { tool: string; count: number; cwd: string; cmd: string[] };

function ext(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

async function main(): Promise<number> {
  let all = false;
  const named: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (arg === "-a" || arg === "--all") all = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return 0;
    } else if (arg.startsWith("-") && arg !== "--") {
      console.error(`autoformat: unknown option: ${arg}`);
      console.error(USAGE);
      return 2;
    } else if (arg !== "--") named.push(arg);
  }

  let status = 0;
  const files = new Set<string>();
  let gitRoot: string | null = null;

  if (named.length === 0) {
    if (all) collectDir(process.cwd(), files);
    else {
      gitRoot = await gitDirty(files);
      if (gitRoot === null) collectDir(process.cwd(), files);
    }
  } else {
    for (const path of named) {
      if (!existsSync(path)) {
        console.error(`autoformat: no such file or directory: ${path}`);
        status = 1;
      } else if (statSync(path).isDirectory()) collectDir(path, files);
      else addFile(path, files);
    }
  }

  // Group by formatter so each one runs once over many files. format:file is
  // the exception: the convention is one path per call.
  const oxfmtByConfig = new Map<string, string[]>();
  const denoByRoot = new Map<string, string[]>();
  const formatFile: { root: string; file: string }[] = [];
  const py: string[] = [];
  const nix: string[] = [];

  for (const file of [...files].sort()) {
    const e = ext(file);
    if (WEB_EXTS.has(e)) {
      const target = resolveWebTool(file);
      if (target.tool === "format:file") formatFile.push({ root: target.root, file });
      else if (target.tool === "deno") push(denoByRoot, target.root, file);
      else push(oxfmtByConfig, target.config, file);
    } else if (e === "py") py.push(file);
    else if (e === "nix") nix.push(file);
  }

  const jobs: Job[] = [];
  const missing = new Map<string, number>();
  const need = (tool: string, count: number): boolean => {
    if (Bun.which(tool)) return true;
    missing.set(tool, (missing.get(tool) ?? 0) + count);
    return false;
  };

  for (const [config, batch] of oxfmtByConfig) {
    if (need("oxfmt", batch.length)) {
      jobs.push({
        tool: "oxfmt",
        count: batch.length,
        cwd: "/",
        cmd: ["oxfmt", "-c", config, ...batch],
      });
    }
  }
  for (const [root, batch] of denoByRoot) {
    if (need("deno", batch.length)) {
      jobs.push({ tool: "deno", count: batch.length, cwd: root, cmd: ["deno", "fmt", ...batch] });
    }
  }
  for (const { root, file } of formatFile) {
    const pm = detectPm(root);
    if (!need(pm, 1)) continue;
    // npm needs `--` to forward args to the script; bun/pnpm/yarn do not.
    const cmd =
      pm === "npm" ? ["npm", "run", "format:file", "--", file] : [pm, "run", "format:file", file];
    jobs.push({ tool: "format:file", count: 1, cwd: root, cmd });
  }
  if (py.length && need("ruff", py.length)) {
    jobs.push({
      tool: "ruff",
      count: py.length,
      cwd: "/",
      cmd: ["ruff", "check", "--fix", "--quiet", ...py],
    });
    jobs.push({ tool: "ruff", count: 0, cwd: "/", cmd: ["ruff", "format", "--quiet", ...py] });
  }
  if (nix.length && need("alejandra", nix.length)) {
    jobs.push({
      tool: "alejandra",
      count: nix.length,
      cwd: "/",
      cmd: ["alejandra", "--quiet", ...nix],
    });
  }

  const done = new Map<string, number>();
  for (const job of jobs) {
    const result = await run(job.cmd, job.cwd);
    if (!result.ok) {
      console.error(`autoformat: ${job.tool} failed`);
      if (result.output.trim()) console.error(result.output.trim());
      status = 1;
      continue;
    }
    if (job.count) done.set(job.tool, (done.get(job.tool) ?? 0) + job.count);
  }

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

  for (const [tool, count] of [...missing].sort(([a], [b]) => a.localeCompare(b))) {
    console.error(`autoformat: ${tool} not found, skipped ${count} file(s)`);
  }

  return status;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const batch = map.get(key);
  if (batch) batch.push(value);
  else map.set(key, [value]);
}

process.exit(await main());
