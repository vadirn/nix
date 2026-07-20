---
name: glossary
description: >
  Bootstrap and maintain a project glossary as a 2-column Markdown table. Triggers: /glossary, "build a glossary", "document the jargon", "define project terms". Use proactively when the user discusses ambiguous domain terminology.
---

# Glossary

Thin wrapper: the doctrine lives in the vault note `Glossary`. Load it at invocation — never run from memory of it.

## Parameters

- `mode=bootstrap|update`: default auto-detect. `bootstrap` if no glossary exists, `update` if one is found.
- `scope=repo|path`: default `repo`. With `path`, restrict the codebase scan to a subtree given as an argument.
- `--inline`: emit only the paragraph + table fragment (no `# Glossary` H1, no file write — print to stdout for the caller to splice in).

```
scan_root = args.path if scope == "path" else CWD

// Load doctrine
note_path = Bash(vault-query get "00 inbox/Glossary")
if note_path missing or ambiguous: do("report the error to the user"); stop

// (parallel)
rules = Bash(vault-query read <note_path> 0)
output = Bash(vault-query read <note_path> "Output format")
definitions = Bash(vault-query read <note_path> "Definitions")
pinning = Bash(vault-query read <note_path> "Pinned vs un-pinned")
selection = Bash(vault-query read <note_path> "Candidate selection")
update_rules = Bash(vault-query read <note_path> "Update mode")
inline_rules = Bash(vault-query read <note_path> "Inline mode")
if any read errors: do("report the exact error and note_path to the user"); stop

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

candidates = do("scan the codebase within scan_root and rank domain-term candidates per selection")

proposals = []
for each candidate not already a Term in existing_table:
    proposals.append(do("draft a one-line definition grounded in code usage, per definitions"))
do("surface conflicts between candidates and existing terms per update_rules")

do("present the full proposal list to the user; for each: confirm / edit / skip / mark-pinned")

merged = existing_table
for each confirmed proposal:
    if marked pinned:
        merged.pinned.append({ term: "**" + name + "**", definition: text })
    else:
        merged.unpinned.append({ term: name, definition: text })

do("sort merged.unpinned A–Z by Term; leave merged.pinned in declared order")
do("render to target per output (inline_rules govern --inline); for standalone GLOSSARY.md prepend '# Glossary' H1")
do("report: N terms added, M terms unchanged, P pinned, U un-pinned")
```

## Reference

### Doctrine loading

- `vault-query get "00 inbox/Glossary"` resolves the note. The path-qualified fragment is required: a bare `"Glossary"` is ambiguous — it also matches `41 projects/tessera/GLOSSARY.md`.
- Structured reads (`vault-query read` with addresses) load the intro (address `0`) and the six doctrine sections, keeping the note's frontmatter out of context.
- Fail loud, never improvise: on any resolution or address error the doctrine has moved or its headings were renamed — a workflow reconstructed from memory looks like success while silently degrading the contract. The section headings `Output format` / `Definitions` / `Pinned vs un-pinned` / `Candidate selection` / `Update mode` / `Inline mode` are part of this wrapper's contract with the note. The note is authoritative for the `--inline` fragment contract.
