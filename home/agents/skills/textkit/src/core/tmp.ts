import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Create a fresh temp directory and return the path to a .md file inside it (not
// yet created — the caller writeFileSync's the content). A dedicated dir per call
// keeps the name collision-free without depending on a platform mktemp binary's
// flag syntax (GNU coreutils' --suffix is not portable). The result is written
// to a real .md artifact (openable, diffable) instead of stdout so the caller can
// hand back the path while stdout carries only that path. `prefix` names the dir
// (e.g. "distill-", "polish-") so temp dirs stay attributable to their producer.
export function tempMdPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "out.md");
}
