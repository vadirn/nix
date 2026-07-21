---
name: glossary
description: >
  Build and maintain an inline project glossary as a 2-column Markdown table embedded in an existing document (a track's Glossary section, an experiment record, a README). Triggers: /glossary, "build a glossary", "document the jargon", "define project terms". Use proactively when the user discusses ambiguous domain terminology.
---

# Glossary

Build and maintain a glossary as a 2-column Markdown table (`| Term | Definition |`) embedded in an existing document. The skill emits a paragraph + table fragment; the host file (a track's `## Glossary` section, an experiment record, a README) owns where it lives. There is no standalone glossary file: a dedicated `GLOSSARY.md` imposes a documentation spec on the project and rots apart from the documents that use its terms.

## Parameters

- `file`: the host file to embed into. When omitted, print the fragment to stdout for the caller to splice in.
- `scope=repo|path`: default `repo`. With `path`, restrict the codebase scan to a subtree given as an argument.

```
scan_root = args.path if scope == "path" else CWD

if args.file exists and contains a "## Glossary" section:
    existing_table = parse the 2-col table from that section
    mode = update
else:
    existing_table = { pinned: [], unpinned: [] }
    mode = bootstrap

do("scan codebase within scope for domain terms: class names, table names, enum values, recurring noun phrases in comments and docs")
candidates = do("rank by frequency and prominence; drop framework/stdlib nouns and generic words")

proposals = []
for each candidate not already a Term in existing_table:
    proposals.append(do("draft a one-line definition grounded in how the term is used in code"))

do("present the full proposal list to the user; for each: confirm / edit / skip / mark-pinned")

merged = existing_table
for each confirmed proposal:
    if marked pinned:
        merged.pinned.append({ term: "**" + name + "**", definition: text })
    else:
        merged.unpinned.append({ term: name, definition: text })

do("sort merged.unpinned A–Z by Term; leave merged.pinned in declared order")
do("render the explanatory paragraph + table; write into the host file's ## Glossary section, or print to stdout when no file was named")
do("report: N terms added, M terms unchanged, P pinned, U un-pinned")
```

## Output format

A 2-column Markdown table preceded by one explanatory paragraph. The fragment starts with the paragraph — no heading; the host file supplies its own `## Glossary` header.

```markdown
Rows whose **Term** is bolded are pinned: text, position, and presence are fixed, and update passes must not edit them. Append project-specific terms beneath the baseline as un-pinned rows; refine an existing un-pinned term by appending a new row with the sharpened wording rather than rewording in place.

| Term | Definition |
| --- | --- |
| **Order** | A confirmed purchase with a fixed line-item list. Distinct from a Cart (mutable, pre-checkout). |
| **Cart** | An in-progress shopping basket. Mutable until checkout; promoted to Order on payment confirmation. |
| AuditTrail | Append-only log of state changes attached to a domain entity. Read by the compliance dashboard, not by handlers. |
| Idempotency-Key | Header used to deduplicate POST requests at the API layer. Stored in `idempotency_keys` table for 24h. |
```

Pinned rows precede un-pinned rows; un-pinned rows sort A–Z.

## Reference

### What makes a good term definition

A good definition is short, concrete, and names the property that sets the term apart from adjacent concepts.

Weak: "**Order**: an order placed by a user." Strong: "**Order**: a confirmed purchase with a fixed line-item list; distinct from Cart (mutable, pre-checkout)."

The strong form names what differentiates the term from adjacent concepts (`Cart`) and fixes a property that code can depend on (`fixed line-item list`).

### Pinned vs. un-pinned

- **Pinned** (`**Term**` — bolded): baseline rows the table's template or owner placed deliberately — pinning exists so automated updates (a `/track` save, an update-mode rewrite) cannot mangle them. Keep their text, position, and presence fixed. New candidates found by scanning are un-pinned by default; pin a row only when its wording was set deliberately and an update pass must not touch it.
- **Un-pinned** (`Term` — plain): the working vocabulary. Append-only by convention; refine by appending a new row with sharpened wording rather than rewording in place. The history of a term's understanding stays recoverable.

The convention is shared with `/track` and `/experiment` so a reader who's learned one knows all three.

### Candidate selection

Favour terms that already carry meaning in the codebase:

- Class, struct, enum, or type names that appear in more than one file
- Table and column names
- Recurring noun phrases in comments or docs

Drop terms that belong to the framework or standard library: `Request`, `Response`, `String`, `List`. These are not project-specific.

### Update mode

In update mode, pinned rows remain fixed (enforced by the skill, not just by convention). Un-pinned rows can be sorted A–Z on every write — sorting is deterministic so diffs stay clean. New candidates are appended after user confirmation. If a candidate matches an existing term with a different definition, surface the conflict: "the glossary defines Order as X; code suggests Y. Append a refining row?"

### Boundary with other skills

- `/track` and `/experiment` use the same table format for their per-artifact glossaries; a `/track save` or `/experiment` record write is a typical caller splicing the fragment in.
- `/probe` cross-checks a plan's terminology against whatever glossary the project carries; this skill maintains embedded glossaries, so probe's vocabulary source is the host documents.
