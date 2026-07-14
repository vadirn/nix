// frontmatter — split off and read the leading YAML metadata block. Pure string
// handling; the metadata passes through the pipeline verbatim, so this module only
// locates it and reads a few well-known keys.

// ---- frontmatter: YAML metadata block fenced by --- at the very start ----

// A frontmatter fence line: `---` or `...`, tolerating a trailing CR and trailing
// whitespace so a trailing-space `--- ` still opens/closes the block. The single
// predicate both scanners share, so opening-fence tolerance and closing-fence
// tolerance can never drift — a source note whose closing fence carries trailing
// whitespace must not parse in one scanner yet read as unclosed in the other.
function isFenceLine(line: string): boolean {
  const t = line.replace(/\r$/, "").trim();
  return t === "---" || t === "...";
}

/// One structural scan of a document's leading frontmatter block.
export interface Frontmatter {
  /// The frontmatter block, fences included, trailing newline kept, BOM stripped.
  /// "" when the text has no opening `---` fence. Passes through the pipeline
  /// verbatim — it is metadata, never segmented, graded, or reworded.
  front: string;
  /// The body after the closing fence (one separating blank line dropped), or the
  /// whole BOM-stripped text when there is no complete block.
  body: string;
  /// Parse-failure message when the block opened and closed but its inner YAML did
  /// not parse — mirrors the Rust side's `frontmatter_error`. null when the block
  /// parsed cleanly or there was no block. A flagged block is STILL returned in
  /// `front` (kept verbatim, never demoted to body), so malformed metadata is
  /// surfaced rather than silently reworded as prose.
  error: string | null;
}

// Split off leading frontmatter so it passes through verbatim — it is metadata,
// not prose, and must never be segmented, graded, or reworded. One structural pass
// replaces the former fragile string-prefix fence test: the BOM is stripped up
// front (so a BOM-prefixed fence is still a fence) and both delimiters are matched
// by TRIMMED line equality (so a trailing-space `---`/`...` still closes the block),
// the same rule the Rust `frontmatter::block` scanner uses. The inner YAML is then
// validated once; a parse failure is flagged in `error` while the block stays in
// `front`, so a malformed block is never demoted to body and reworded as prose.
// An opening `---` with no closing fence is not a complete block — the whole text
// is body (mirrors the Rust `Ok(None)` case).
export function parseFrontmatter(text: string): Frontmatter {
  const stripped = text.replace(/^\uFEFF/, "");
  const lines = stripped.split("\n");
  // Opening delimiter: the first line, trimmed, must be a fence.
  if (!isFenceLine(lines[0])) return { front: "", body: stripped, error: null };
  for (let i = 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      const front = lines.slice(0, i + 1).join("\n") + "\n";
      const body = lines
        .slice(i + 1)
        .join("\n")
        .replace(/^\n/, ""); // drop one separating blank line
      const inner = lines
        .slice(1, i)
        .map((l) => l.replace(/\r$/, ""))
        .join("\n");
      let error: string | null = null;
      try {
        Bun.YAML.parse(inner);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      return { front, body, error };
    }
  }
  return { front: "", body: stripped, error: null };
}

// Default the trust tier of distilled output. An agent-distilled note is
// unverified until curated, so its frontmatter must carry
// `epistemic_status: provisional` — otherwise `vault-query` retrieval, whose
// absent-key default is `certified` (the trusted tier), would serve it as ground.
// An existing `epistemic_status:` line is the author's explicit choice
// and is left untouched; every other frontmatter line is preserved byte-for-byte.
// When the source has no frontmatter at all, a minimal block is created.
export function ensureEpistemicStatus(front: string): string {
  if (/^epistemic_status:/m.test(front)) return front; // explicit choice wins
  const LINE = "epistemic_status: provisional";
  const crlf = front.includes("\r\n");
  const nl = crlf ? "\r\n" : "\n";
  if (front === "") return `---${nl}${LINE}${nl}---${nl}`;
  // front holds opening + closing fences and a trailing newline. Insert the key
  // immediately before the closing fence (the last `---`/`...` line).
  const lines = front.split(nl);
  let close = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isFenceLine(lines[i])) {
      close = i;
      break;
    }
  }
  if (close <= 0) return front; // malformed (no distinct closing fence): leave as-is
  lines.splice(close, 0, LINE);
  return lines.join(nl);
}

// Read a single-line scalar `key:` value out of frontmatter: match the first such
// line, trim it, and strip one surrounding quote pair. Returns "" when the key is
// absent. The shared scan behind parseDescription/parseType, so the two read a key
// the same way.
function readFrontKey(front: string, key: string): string {
  const m = front.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

// Pull an authored single-line `description:` value out of frontmatter. This is
// the one independent ground-truth anchor — when present it overrides the
// model's extracted description so the anchor is never paraphrased. A blank or
// block-scalar (|/>) description is treated as absent (nothing authored to pin).
export function parseDescription(front: string): string {
  const v = readFrontKey(front, "description");
  if (!v || v === "|" || v === ">") return "";
  return v;
}

// Pull the frontmatter `type:` value (note / card / reference / …). distill never
// authors `type` and today never emits a reference body, so this feeds ONLY a
// defensive guard: a future reference-distill path must stay link-free (no `##
// Relations` block in a type:reference body). Returns "" when absent.
export function parseType(front: string): string {
  return readFrontKey(front, "type").toLowerCase();
}

// A `superseded: true` note is retired content the curator has moved past — distill is
// licensed to drop it wholesale, so the prose-list-item gate skips it rather than
// flooding the footer with advisory residue. Returns false when absent or any non-true value.
export function parseSuperseded(front: string): boolean {
  return /^superseded:[ \t]*true[ \t]*$/im.test(front);
}
