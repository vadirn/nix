// Preload seam for the bin/ wrappers: teaches Bun's runtime to resolve the `@/*`
// alias regardless of the caller's cwd.
//
// Bun reads tsconfig.json only from the exact cwd — it does not walk up from the
// entrypoint — so `@/core/text.ts` resolved only when a CLI was invoked from the
// textkit root and crashed with "Cannot find module" from anywhere else. The three
// PATH binaries (see home/claude.nix) are symlinks into bin/, so every real
// invocation site was a foreign cwd.
//
// The prefix and src dir come from tsconfig's compilerOptions.paths — the same
// single source of truth scripts/boundaries.ts reads — so the alias cannot drift
// between the type checker, the boundary lint, and the runtime.

import { plugin } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * Derive the alias prefix and src directory from tsconfig compilerOptions.paths.
 * Expects a single `@/* -> ./src/*` style entry: the key without its `*` is the
 * specifier prefix, the target without `./` and `*` is the src dir.
 */
function resolveAlias(): { prefix: string; srcRel: string } {
  const cfg = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
  const paths = cfg.compilerOptions?.paths ?? {};
  const entry = Object.entries(paths)[0] as [string, string[]] | undefined;
  if (!entry) throw new Error("tsconfig compilerOptions.paths has no alias entry");
  const [key, targets] = entry;
  const prefix = key.replace(/\*$/, ""); // "@/*" -> "@/"
  const srcRel = targets[0]!.replace(/^\.\//, "").replace(/\*$/, "").replace(/\/$/, ""); // "./src/*" -> "src"
  return { prefix, srcRel };
}

const { prefix, srcRel } = resolveAlias();
const SRC = join(ROOT, srcRel);

plugin({
  name: "textkit-alias",
  setup(build) {
    build.onResolve(
      { filter: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) },
      (args) => ({
        path: join(SRC, args.path.slice(prefix.length)),
      }),
    );
  },
});
