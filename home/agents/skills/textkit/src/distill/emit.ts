// emit — distill's output-read CONTRACT: the sole surface cards/ imports from distill.
//
// cards/ consumes an already-emitted distilled note (a body string, never a distill() call)
// and must read it back through exactly ONE seam, not by reaching into four internal readers.
// This module is that seam: a curated re-export, NO logic. Every symbol below is the public
// read-surface a card-extraction consumer needs — the canonical-note reader, the `## Relations`
// rebuild parser, the section splitter, and the interact strip plus its format-error. Widen this
// deliberately; a new cross-import from cards/ into graph/ · extract/ · review/ is a contract
// leak, not a shortcut.
export { parseCanonicalNote } from "#src/distill/graph/parse-projection.ts";
export { parseRelationsBlock } from "#src/distill/graph/rel-parse.ts";
export { sections } from "#src/distill/extract/route.ts";
export { InteractFormatError, stripInteract } from "#src/distill/review/interact.ts";
