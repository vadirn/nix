// simplify/brief — coerce the model's JSON into a SimplifyBrief, then render it to the markdown
// brief on stdout. Two layers, two formats (report-brief's decision): the model returns strict
// JSON through askJson; the CLI prints markdown with the seven `##` sections plus `## guard`. No
// textkit CLI prints JSON to stdout — the brief is the analyzer's product.
//
// coerceBrief is defensive: askJson enforces the shape through a schema retry, but a surviving
// dropped or mistyped key must degrade to an empty section, never crash the CLI. The renderer
// expects display-ready fields — the CLI unmasks `rewrite` and each `change` span before calling.
import type { ChangeItem, SimplifyBrief } from "textkit/simplify/prompt.ts";
import { type GuardReport, formatGuard, guardClean } from "textkit/simplify/guard.ts";

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// Coerce one raw `change` entry to a ChangeItem, or null when it lacks a before/after pair (the
// two fields the human and the guard actually check). transform/why default to empty.
function coerceChange(v: unknown): ChangeItem | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const before = asStr(o.before);
  const after = asStr(o.after);
  if (!before && !after) return null;
  return { before, after, transform: asStr(o.transform), why: asStr(o.why) };
}

// coerceBrief turns the model's parsed JSON into a total SimplifyBrief — every field present, each
// with its declared type. A missing key becomes an empty value, so the render never throws.
export function coerceBrief(raw: unknown): SimplifyBrief {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    verdict: asStr(o.verdict),
    cut: asStrArr(o.cut),
    change: Array.isArray(o.change)
      ? o.change.map(coerceChange).filter((c): c is ChangeItem => c !== null)
      : [],
    shape: asStrArr(o.shape),
    keep: asStrArr(o.keep),
    borderline: asStrArr(o.borderline),
    rewrite: asStr(o.rewrite),
  };
}

// Render a string list as markdown bullets, or "None." when empty — so an empty section reads as a
// deliberate no-finding, not a rendering gap.
const bullets = (items: string[]): string =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : "None.";

// Render the `change` diff: one bullet per itemized edit, "before" → "after" with its transform and
// reason. Concrete before/after so the human checks it against the rewrite.
const renderChange = (items: ChangeItem[]): string =>
  items.length
    ? items
        .map(
          (c) =>
            `- **${c.transform || "edit"}**: "${c.before}" → "${c.after}"${c.why ? ` — ${c.why}` : ""}`,
        )
        .join("\n")
    : "None.";

// Choose a fence long enough to wrap `content` without an inner ``` run closing it early: one more
// backtick than the longest run inside, floor 4 (report-brief wraps the rewrite in a ```markdown
// fence, and a restyled note routinely contains its own triple-fenced code).
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  return "`".repeat(Math.max(4, longest + 1));
}

// renderBrief renders the display-ready brief and guard report to the markdown brief printed on
// stdout: the seven `##` sections in fixed order, then `## guard`. `rewrite` is fenced so the
// subagent extracts one block; `guard` leads with "All checks passed." when every axis is clean.
export function renderBrief(brief: SimplifyBrief, guard: GuardReport): string {
  const fence = fenceFor(brief.rewrite);
  const guardBody = guardClean(guard)
    ? `All checks passed.\n\n${formatGuard(guard)}`
    : formatGuard(guard);
  return [
    `## verdict\n\n${brief.verdict || "No verdict."}`,
    `## cut\n\n${bullets(brief.cut)}`,
    `## change\n\n${renderChange(brief.change)}`,
    `## shape\n\n${bullets(brief.shape)}`,
    `## keep\n\n${bullets(brief.keep)}`,
    `## borderline\n\n${bullets(brief.borderline)}`,
    `## rewrite\n\n${fence}markdown\n${brief.rewrite}\n${fence}`,
    `## guard\n\n${guardBody}`,
  ].join("\n\n");
}
