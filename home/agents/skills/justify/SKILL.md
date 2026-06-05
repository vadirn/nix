---
name: justify
description: >
  Demand a sufficient reason for each element — code, plan step, or action — and recommend cutting
  whatever cannot earn its place. Applies the principle of sufficient reason to artifacts: every
  function, abstraction, dependency, flag, step, or command must justify its existence or be flagged.
  Use when the user invokes /justify or asks "do we need this", "why does this exist", "what's this
  for", "is this necessary", "what can we cut", "find dead weight". Defaults to the working-tree diff;
  "justify actions" audits the recent action transcript; pass a file path or plan to audit that. To
  stress-test a plan's decisions use /probe; for code cleanups that assume the code should stay use
  /simplify.
---

# Justify

Point at each element and demand a sufficient reason. Recommend cutting what has none.

A claim is justified only on two grounds: a logical ground (it follows from a real goal) and a real
ground (the goal is wanted and the facts it assumes hold). An element earns its place the same way.
Whatever cannot supply both is dead weight, carried at the cost of every future reader.

## Parameters

- `target` (optional): What to audit. Inline text, a file path, the word `actions`, or empty. Empty
  defaults to the working-tree diff. Conversation context is used when it carries the plan.

```
target = <args> or working-tree diff
if no args and the working-tree diff is empty: AskUserQuestion("Nothing staged or unstaged to audit. Justify this session's actions, or a plan/file path?"), then stop

// Resolve the mode
if target in {"actions","transcript","steps"}: mode = actions
else if target is a file path, inline prose, or a plan in context: mode = text
else: mode = diff

// Enumerate discrete elements
if mode == diff:
    diff = Bash(git diff HEAD)
    do("enumerate each added or changed element in diff: function, class, abstraction layer, dependency, config key, conditional branch, flag, parameter")
if mode == actions:
    do("enumerate each discrete action in the recent transcript: command run, file written, tool call, workflow step")
if mode == text:
    if target is a file path: target = Read(<path>)
    do("enumerate each discrete element: step, requirement, claim, section, option")

// Independence — authorship decides the auditor, not who launches the skill
authored_here = do("did this agent produce the target in this session: a diff I just wrote, or this session's own actions?")
if authored_here: do("run the test in a fresh auditor subagent; pass it the element list, the test, and any asserted grounds marked as claims to test, not facts; this agent orchestrates and presents, it does not grade its own work")
else: do("run the test inline; the target is external, so this agent is already independent of it")

// The test — per element
for each element:
    purpose = do("state the element's claimed purpose; if none is discoverable, set purpose = none")
    logical_ground = do("does anything actually depend on it; does removing it break a stated requirement?")
    real_ground = do("is the goal wanted and do its facts hold; can the input it guards against occur on this path?")
    verdict =
        both grounds hold                -> keep
        a ground fails                   -> cut
        purpose or ground undeterminable -> ask

// Demote over-eager cuts
do("re-test every cut against the guardrails in Reference: What not to cut; demote any with a real ground back to keep")

// Output
do("emit the verdict table; cuts and asks first, kept elements summarized by count")
do("for each cut: claimed purpose, the failing ground, the concrete removal")
do("for each ask: the precise question that settles keep-or-cut")
do("close with: N checked, K to cut, A to clarify, rest justified")
```

## Reference

### Terms

| term              | meaning                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| element           | one discrete thing under audit: a function, abstraction, dependency, flag, step, or command |
| claimed purpose   | the goal the element is supposed to serve                                                   |
| logical ground    | something real depends on the element; removing it breaks a stated requirement              |
| real ground       | the goal is actually wanted and the facts it assumes hold                                   |
| sufficient reason | both grounds present; the bar an element clears to be kept                                  |
| keep              | both grounds hold (reported as a count, not listed)                                         |
| cut               | a ground fails; nothing real needs the element                                              |
| ask               | purpose or ground cannot be determined from the artifact alone                              |

Most dead weight fails the real ground, not the logical one: code written for a problem the codebase
does not have. The logical chain is intact (things call it), but the goal it serves is imaginary. State
the purpose first, then test each ground against it.

### The ask branch

The ask verdict separates this from a linter. A linter deletes what nothing references; it has no
branch for "this is referenced, but I cannot tell whether the reference itself is needed." That branch
is where the real waste hides, and it is settled by asking the author, not guessing.

### Independence of the auditor

A verdict is worth the distance between auditor and author. A sufficient reason must be established
independently of what it supports, the way a proof's premises are established apart from its thesis.
When this agent wrote the artifact, that distance is zero: it rationalized each element while writing it
and re-endorses those rationalizations on a warm re-read. So authorship, not the mode, decides who audits.

- Authored by this agent this session (a just-written diff, this session's actions): dispatch a fresh
  auditor. It reconstructs each purpose from the artifact alone and tests asserted grounds skeptically.
- Authored by the user or already in the tree (a pasted plan, legacy code): audit inline. This agent
  did not write it, so it is already independent; isolating it would discard the conversation context
  that supplies legitimate real grounds.

Always-isolate discards real grounds that live in context (a flag wired for next sprint is justified by
knowledge the diff does not show). Never-isolate returns a warm audit that launders the author's
choices. Match the auditor to the authorship. To force a quick inline check on your own work despite the
warmth, ask for it and read the result as non-independent.

### What not to cut

A real ground is a sufficient reason even when nothing in the diff visibly depends on the element.
Demote these back to keep:

- **Defensive correctness with a reachable trigger.** `if conn is None: raise` is justified when a
  caller can reach it before connecting. Cut it only when the bad input cannot occur on any path.
- **External contract.** A field or method shape a framework, API, or serializer demands, even when
  your own code never reads it directly.
- **Readability scaffolding.** A named intermediate or small helper whose purpose is clarity. Faster
  comprehension is a real ground; do not trade it for line count.
- **Declared-throwaway code.** Spikes and prototypes the user marked exploratory (see /prototype). Their
  goal is to answer a question, not to survive.
- **Test coverage.** A test's real ground is the behavior it guards, not whether anything depends on it.

### Examples

**Cut (failed real ground).** `retryWrapper()` around a startup config read. Purpose: "survive flaky
I/O." A local read on startup has no transient failure mode, so there is nothing to retry. → cut; call
the read directly.

**Ask (undeterminable logical ground).** A `--verbose` flag added in the diff, with no code branching on
it. → ask: "Is `--verbose` wiring for planned work, or a leftover? Nothing consumes it yet."

**Keep (guardrail).** `if user is None: return 401` in a request handler. An unauthenticated request can
reach it. → keep; defensive code with a reachable trigger is justified.

**Cut (redundant action).** A second `npm install` after one already succeeded, with no lockfile change
between. The tree was already complete. → cut.

### Output structure

```
| element | claimed purpose | grounds | verdict |
|---------|-----------------|---------|---------|
| <name>  | <purpose>       | <which ground fails, or "both hold"> | cut / ask |

### Cuts
- **<element>** — purpose was "<purpose>"; <ground> fails because <fact>. Remove: <concrete edit>.

### Clarify
- **<element>** — <the question whose answer is keep-or-cut>.

<N> checked · <K> to cut · <A> to clarify · <rest> justified.
```

### Boundaries with sibling skills

- **/simplify** assumes the code should exist and proposes a smaller form. Justify questions whether it
  should exist at all. On a plan or an action transcript, justify covers ground simplify does not.
- **/probe** interrogates a plan's decisions for soundness ("is this the right choice?"). Justify
  interrogates elements for necessity ("does this need to exist?"). A decision can be sound and still unnecessary.
- **/code-review** hunts bugs and broad cleanups. Justify runs one axis: sufficient reason to exist.
- **knip** finds what nothing references — mechanical dead code. Justify finds what is referenced but
  whose reference chain has no real ground. Run knip first, then justify.
- **/logic-check** audits an argument's reasoning. Justify audits an artifact's necessity — same
  principle, different object.
