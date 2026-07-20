// The workspace types Bun APIs from the pinned @types/bun. A bun on PATH older
// than that pin type-checks against APIs its runtime lacks — Bun.file().image()
// surfaced this as TS2339 rather than "wrong bun". Assert the two agree first so
// the failure names its cause.
import pkg from "../package.json" with { type: "json" };

const pinned = pkg.devDependencies["@types/bun"];

if (Bun.version !== pinned) {
  console.error(
    `bun ${Bun.version} on PATH, but @types/bun is pinned to ${pinned}.\n` +
      `Resolved from: ${Bun.which("bun") ?? "unknown"}\n` +
      `Type errors below this line are version skew, not code defects.\n` +
      `Fix the PATH (a stale ~/.bun/bin/bun shadows homebrew) or move the pin.`,
  );
  process.exit(1);
}
