// Barrel for the core concern: the shared substrate every other slice (distill,
// polish, cards) draws on. Flat re-export of core's public API, no logic of its
// own. `typography` is surfaced through `text.ts`, which re-exports
// `normalizeTypography`; starring it here too would make that name an ambiguous
// re-export, so it is intentionally omitted.
export * from "@/core/fw.ts";
export * from "@/core/text.ts";
export * from "@/core/frontmatter.ts";
export * from "@/core/writing/name-lint.ts";
export * from "@/core/writing/levenshtein.ts";
export * from "@/core/writing/mask.ts";
export * from "@/core/writing/passes.ts";
