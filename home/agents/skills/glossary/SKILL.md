---
name: glossary
description: >
  Bootstrap and maintain a project glossary as a 2-column Markdown table. Triggers: /glossary,
  "build a glossary", "document the jargon", "define project terms". Use proactively when the user
  discusses ambiguous domain terminology.
---

# Glossary

Bootstrap and maintain a glossary as a 2-column Markdown table (`| Term | Definition |`). Default output is a standalone `GLOSSARY.md` at repo root; with `--inline`, emit only the paragraph + table fragment for embedding in another markdown file (a track's `## Glossary` section, an experiment record, a README).

## Parameters

- `mode=bootstrap|update`: default auto-detect. `bootstrap` if no glossary exists, `update` if one is found.
- `scope=repo|path`: default `repo`. With `path`, restrict the codebase scan to a subtree given as an argument.
- `--inline`: emit only the paragraph + table fragment (no `# Glossary` H1, no file write — print to stdout for the caller to splice in).

```
scan_root = args.path if scope == "path" else CWD

if --inline:
    target = stdout
    named_file = args.file (the file the caller names)
    if named_file exists and contains a "## Glossary" section:
        existing_table = parse the 2-col table from that section (same logic as update mode)
    else:
        existing_table = { pinned: [], unpinned: [] }
    mode = update
elif ./GLOSSARY.md exists:
    target = ./GLOSSARY.md
    existing_table = parse the existing 2-col table from ./GLOSSARY.md
    mode = update
else:
    target = ./GLOSSARY.md
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
do("render the explanatory paragraph + table to target; for standalone GLOSSARY.md prepend '# Glossary' H1")
do("report: N terms added, M terms unchanged, P pinned, U un-pinned")
```

## Output format

A 2-column Markdown table preceded by one explanatory paragraph. Standalone files add a `# Glossary` H1 above the paragraph; `--inline` output starts with the paragraph.

```markdown
# Glossary

Rows whose **Term** is bolded are pinned: text, position, and presence are fixed, and update passes must not edit them. Append project-specific terms beneath the baseline as un-pinned rows; refine an existing un-pinned term by appending a new row with the sharpened wording rather than rewording in place.

| Term            | Definition                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Order**       | A confirmed purchase with a fixed line-item list. Distinct from a Cart (mutable, pre-checkout).                  |
| **Cart**        | An in-progress shopping basket. Mutable until checkout; promoted to Order on payment confirmation.               |
| AuditTrail      | Append-only log of state changes attached to a domain entity. Read by the compliance dashboard, not by handlers. |
| Idempotency-Key | Header used to deduplicate POST requests at the API layer. Stored in `idempotency_keys` table for 24h.           |
```

Pinned rows precede un-pinned rows; un-pinned rows sort A–Z.

## Reference

### What makes a good term definition

A good definition is short, concrete, and names the property that sets the term apart from adjacent concepts.

Weak: "**Order**: an order placed by a user."
Strong: "**Order**: a confirmed purchase with a fixed line-item list; distinct from Cart (mutable, pre-checkout)."

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

In update mode, pinned rows remain fixed (enforced by the skill, not just by convention). Un-pinned rows can be sorted A–Z on every write — sorting is deterministic so diffs stay clean. New candidates are appended after user confirmation. If a candidate matches an existing term with a different definition, surface the conflict: "GLOSSARY.md defines Order as X; code suggests Y. Append a refining row?"

### `--inline` mode

Use when the target is not `./GLOSSARY.md` but an embedded glossary section in another file. Output starts directly with the explanatory paragraph; no `# Glossary` H1. The caller (a `/track save` step, an `/experiment` record, a README write) splices the fragment into its target.

### Boundary with probe and other skills

- `/probe` reads `GLOSSARY.md` when cross-checking a plan's terminology. `/glossary` builds and maintains the file; together they let `/probe` catch terminology drift.
- `/track` and `/experiment` use the same table format for their per-artifact glossaries. The shared convention means a reader doesn't have to relearn the format.
