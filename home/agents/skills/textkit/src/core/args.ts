// Consumes the token AFTER a value-flag (`argv[i + 1]`), the shape every value-flag below
// repeats: missing or blank (`--flag ""` / `--flag "  "`, the `--flag "$UNSET"` shell footgun)
// both fail loudly rather than silently defaulting. `hint` completes "<flag> expects <hint>"
// so each call site keeps its own wording; callers still do their own value-specific validation
// (enum/range/suffix checks) on the returned value.
export type TakeValueResult =
  | { ok: true; value: string; next: number }
  | { ok: false; message: string };

export function takeValue(argv: string[], i: number, flag: string, hint: string): TakeValueResult {
  const v = argv[i + 1];
  if (v === undefined || v.trim() === "") return { ok: false, message: `${flag} expects ${hint}` };
  return { ok: true, value: v, next: i + 1 };
}
