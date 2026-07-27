/**
 * Tests for autoformat.ts — selection modes (paths, directory walk, git, -a,
 * --), extension routing, batching, and walk failures.
 * Run: bun test home/scripts/autoformat.test.ts
 * Requires oxfmt and git; the format:file case additionally requires bun. The
 * unreadable-directory case requires a non-root user, since root reads a 000
 * directory anyway.
 */

import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("./autoformat.ts", import.meta.url).pathname;
const HOOK = new URL("../claude/hooks/hint-autoformat.sh", import.meta.url).pathname;
const UGLY = '{   "a":1,"b":   [2,3]}';

function work(): string {
  return mkdtempSync(join(tmpdir(), "autoformat-"));
}

function af(args: string[], opts: { cwd: string; env?: Record<string, string> } = { cwd: "/" }) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

function ugly(path: string): string {
  writeFileSync(path, UGLY);
  return path;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Formatted means oxfmt rewrote it and it is still valid JSON. */
function formatted(path: string): boolean {
  const text = read(path);
  if (text === UGLY) return false;
  JSON.parse(text);
  return true;
}

function git(cwd: string, ...args: string[]) {
  // core.hooksPath=/dev/null: this repo's global commit-msg gate would block a
  // fixture commit that never went through the /commit skill.
  Bun.spawnSync(["git", "-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

test("explicit paths are formatted, spaces and all", () => {
  const dir = work();
  mkdirSync(join(dir, "dir with space"));
  const plain = ugly(join(dir, "plain.json"));
  const spaced = ugly(join(dir, "dir with space", "spaced.json"));
  expect(af([plain, spaced], { cwd: dir }).code).toBe(0);
  expect(formatted(plain)).toBe(true);
  expect(formatted(spaced)).toBe(true);
});

test("extensions autoformat does not route are left alone", () => {
  const dir = work();
  const txt = ugly(join(dir, "notes.txt"));
  af([txt], { cwd: dir });
  expect(read(txt)).toBe(UGLY);
});

test("a directory argument is walked, minus the skip list", () => {
  const dir = work();
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules"));
  const nested = ugly(join(dir, "src", "nested.json"));
  const skipped = ugly(join(dir, "node_modules", "dep.json"));
  af([dir], { cwd: dir });
  expect(formatted(nested)).toBe(true);
  expect(read(skipped)).toBe(UGLY);
});

test("files sharing a formatter are counted in one batch", () => {
  const dir = work();
  ugly(join(dir, "a.json"));
  ugly(join(dir, "b.json"));
  expect(af([dir], { cwd: dir }).out).toContain("oxfmt 2");
});

test("an unreadable directory is reported, and the rest of the walk still runs", () => {
  const dir = work();
  const blocked = join(dir, "blocked");
  mkdirSync(blocked);
  ugly(join(blocked, "unreachable.json"));
  const visible = ugly(join(dir, "visible.json"));
  chmodSync(blocked, 0o000);
  const r = af([dir], { cwd: dir });
  chmodSync(blocked, 0o755);

  expect(r.err).toContain(`cannot read ${blocked}`);
  expect(formatted(visible)).toBe(true);
  // A hole in the walk is not a formatter failure.
  expect(r.code).toBe(0);
});

test("a missing path exits 1, an unknown option exits 2", () => {
  const dir = work();
  expect(af([join(dir, "gone.json")], { cwd: dir }).code).toBe(1);
  expect(af(["--nope"], { cwd: dir }).code).toBe(2);
});

test("-- ends option parsing, so a later -a is a path and not the flag", () => {
  const dir = work();
  mkdirSync(join(dir, "-a"));
  const dashed = ugly(join(dir, "-a", "nested.json"));
  // The leading path is not decoration: bun swallows a -- that directly
  // follows the script path, so the separator has to start further in.
  const seed = ugly(join(dir, "seed.json"));

  expect(af([seed, "--", "-a"], { cwd: dir }).code).toBe(0);
  expect(formatted(seed)).toBe(true);
  expect(formatted(dashed)).toBe(true);
});

test("no args inside a work tree takes git's modified and untracked files", () => {
  const dir = work();
  const sub = join(dir, "sub");
  mkdirSync(sub);
  git(dir, "init", "-q");
  const untracked = ugly(join(dir, "untracked.json"));
  const tracked = join(dir, "tracked.json");
  writeFileSync(tracked, "{}");
  git(dir, "add", "tracked.json");
  git(dir, "commit", "-qm", "init");
  ugly(tracked);
  af([], { cwd: sub });
  expect(formatted(untracked)).toBe(true);
  expect(formatted(tracked)).toBe(true);
});

test("a clean tree names the -a escape hatch and leaves gitignored files alone", () => {
  const dir = work();
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  mkdirSync(join(dir, "ignored"));
  const hidden = ugly(join(dir, "ignored", "hidden.json"));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");

  const clean = af([], { cwd: dir });
  expect(clean.out).toContain("nothing to format");
  expect(clean.out).toContain("-a");
  expect(read(hidden)).toBe(UGLY);

  af(["-a"], { cwd: dir });
  expect(formatted(hidden)).toBe(true);
});

test("outside a work tree, no args walks the cwd", () => {
  const dir = work();
  const file = ugly(join(dir, "cwd.json"));
  af([], { cwd: dir });
  expect(formatted(file)).toBe(true);
});

test("vault-archive snapshots are frozen", () => {
  const dir = work();
  const archive = join(dir, "Documents", "vault-archive");
  mkdirSync(archive, { recursive: true });
  const frozen = ugly(join(archive, "frozen.json"));
  af([frozen], { cwd: dir, env: { HOME: dir } });
  expect(read(frozen)).toBe(UGLY);
});

test("a project format:file script wins over oxfmt", () => {
  const dir = work();
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { "format:file": "printf FORMATTED > " } }),
  );
  writeFileSync(join(dir, "bun.lock"), "");
  const app = ugly(join(dir, "src", "app.ts"));
  af([app], { cwd: dir });
  expect(read(app)).toBe("FORMATTED");
});

test("a workspace-root format:file is inherited by a sub-package", () => {
  const dir = work();
  const pkg = join(dir, "packages", "leaf");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ scripts: { "format:file": "printf FORMATTED > " } }),
  );
  writeFileSync(join(dir, "bun.lock"), "");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "leaf" }));
  const app = ugly(join(pkg, "app.ts"));
  af([app], { cwd: dir });
  expect(read(app)).toBe("FORMATTED");
});

// --- Parity with home/claude/hooks/hint-autoformat.sh -----------------------
//
// The hook re-encodes two facts this router owns, so it can hint without
// paying bun's ~113ms startup on every Write/Edit. Parsing source text this
// way is inherently a little brittle, so each extractor anchors on a literal
// that would only change alongside the fact it reads (the WEB_EXTS set, the
// py/nix routing branches, the FROZEN join, the hook's case patterns) and
// throws a named error if that anchor goes missing, rather than silently
// reporting an empty list as if the two sides agreed.

/** Extensions autoformat.ts routes: WEB_EXTS plus the py and nix branches in routeFiles. */
function routerExtensions(src: string): string[] {
  const webExts = src.match(/const WEB_EXTS = new Set\(\[([\s\S]*?)\]\)/);
  if (!webExts) {
    throw new Error("parity test: WEB_EXTS literal not found in autoformat.ts — update the parser");
  }
  const web = [...webExts[1].matchAll(/"([a-z0-9]+)"/g)].map((m) => m[1]);
  const branches = [...src.matchAll(/e === "(py|nix)"/g)].map((m) => m[1]);
  if (branches.length < 2) {
    throw new Error(
      "parity test: py/nix routing branches not found in autoformat.ts — update the parser",
    );
  }
  return [...web, ...branches];
}

/** Extensions hint-autoformat.sh's case pattern lets through. */
function hookExtensions(src: string): string[] {
  const m = src.match(/case "\$\{FILE##\*\.\}" in([\s\S]*?)\)/);
  if (!m) {
    throw new Error(
      "parity test: extension case pattern not found in hint-autoformat.sh — update the parser",
    );
  }
  return m[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The vault-archive path fragment autoformat.ts's FROZEN constant names. */
function routerFrozenPath(src: string): string {
  const m = src.match(/const FROZEN = join\(HOME, "([^"]+)", "([^"]+)"\)/);
  if (!m) {
    throw new Error("parity test: FROZEN constant not found in autoformat.ts — update the parser");
  }
  return `${m[1]}/${m[2]}`;
}

/** The vault-archive path fragment hint-autoformat.sh's case guard names. */
function hookFrozenPath(src: string): string {
  const m = src.match(/\$\{HOME:-\/nonexistent\}\/([^"]+)\/"\*/);
  if (!m) {
    throw new Error(
      "parity test: frozen-root case guard not found in hint-autoformat.sh — update the parser",
    );
  }
  return m[1];
}

test("hint-autoformat.sh's extension list matches what autoformat.ts routes", () => {
  const router = new Set(routerExtensions(read(CLI)));
  const hook = new Set(hookExtensions(read(HOOK)));
  const onlyInRouter = [...router].filter((e) => !hook.has(e)).sort();
  const onlyInHook = [...hook].filter((e) => !router.has(e)).sort();
  // Named on both sides so a failure says plainly which extension is on the
  // wrong side, instead of just "sets differ".
  expect({ onlyInRouter, onlyInHook }).toEqual({ onlyInRouter: [], onlyInHook: [] });
});

test("hint-autoformat.sh's frozen-root guard matches autoformat.ts's FROZEN constant", () => {
  expect(hookFrozenPath(read(HOOK))).toBe(routerFrozenPath(read(CLI)));
});
