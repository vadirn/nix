---
name: glossary
description: >
  Bootstrap and maintain a project GLOSSARY.md that defines domain-specific terms.
  Use when user invokes /glossary, asks to build a glossary, document domain
  vocabulary, extract key concepts, write up the jargon, define project terms,
  disambiguate terminology, or asks "what does X mean in this codebase" or
  "what are the main entities in this code". Use this proactively when the
  user discusses domain concepts or encounters ambiguous terminology, even if
  they don't ask for a glossary explicitly.
---

# Glossary

Bootstrap and maintain a project `GLOSSARY.md`. One file at the repo root, terms sorted alphabetically, one-line definitions grounded in actual code usage.

## Parameters

- `mode=bootstrap|update`: Default auto-detect. `bootstrap` if `GLOSSARY.md` is absent, `update` if it exists.
- `scope=repo|path`: Default `repo`. When `path`, restrict the codebase scan to a subtree given as an argument.

```
if ./GLOSSARY.md exists:
    mode = update
    terms = do("parse existing ./GLOSSARY.md into {term: definition} map")
else:
    mode = bootstrap
    terms = {}

do("scan codebase within scope for domain terms: class names, table names, enum values, recurring noun phrases in comments and docs")
candidates = do("rank by frequency and prominence; drop framework/stdlib nouns and generic words")

proposals = []
for each candidate not in terms:
    proposals.append(do("draft a one-line definition grounded in how the term is used in code"))

do("present the full proposal list to the user; accept confirm/edit/skip for each entry in a single round")
terms = merge(terms, confirmed proposals)

do("write ./GLOSSARY.md with terms sorted A–Z, using the format below")
do("report: N terms added, M terms unchanged")
```

## File format for `GLOSSARY.md`

No frontmatter, no metadata. Alphabetised by term. One section per term.

```markdown
# Glossary

## Term

One-line definition in plain prose.

Example: short phrase or sentence showing canonical use.
```

Sort A–Z so diffs stay stable across updates.

## Reference

### What makes a good term definition

A good definition is short, concrete, and names the property that sets the term apart from adjacent concepts.

Weak: "**Order**: an order placed by a user."
Strong: "**Order**: a confirmed purchase with a fixed line-item list; distinct from Cart (mutable, pre-checkout)."

The strong form names what differentiates the term from adjacent concepts (`Cart`) and fixes a property that code can depend on (`fixed line-item list`).

### Candidate selection

Favour terms that already carry meaning in the codebase:

- Class, struct, enum, or type names that appear in more than one file
- Table and column names
- Recurring noun phrases in comments or docs

Drop terms that belong to the framework or standard library: `Request`, `Response`, `String`, `List`. These are not project-specific.

### Example bootstrap

Codebase has `class Cart`, `class Order`, `class OrderLine`. Skill proposes three definitions grounded in how they are constructed and mutated. User confirms two, edits one, skips none. Resulting `GLOSSARY.md` has three sorted entries.

### Update mode

In update mode, confirmed entries are left untouched. New candidates are appended after user confirmation. If a candidate matches an existing term with a different definition, surface the conflict: "GLOSSARY.md defines Order as X; code suggests Y. Reconcile?"

### Boundary with probe

Probe reads `GLOSSARY.md` when cross-checking a plan's terminology. Glossary builds and maintains the file. Each works alone; together they let probe catch terminology drift.
