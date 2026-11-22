---
name: verify
description: >
  Produce evidence for each claim a finished change makes, before calling it done: restate each
  claim so a run can refute it, show its tests fail on the source before the change and on each
  removed condition, run one claim-directed review, then stop by rule. Emits a `## Verification`
  section for the PR body. Triggers: /verify, "verify this change", "verify the PR", "is this
  really done", "prove the fix", "can these tests fail". Runs only when asked.
  Skip for a claim about existing behavior with no change under test (use /experiment), writing
  tests first (use /tdd), a general bug hunt (use /code-review), launching the app (use /run), or
  a plan too vague to yield claims (use /probe).
---

# Verify

A passing suite shows the checks ran. This skill asks whether they could have failed.

Input is a finished change. Output is a verdict per claim, with the command that produced each.

## Forces

Each step names the force it serves.

1. **Refutable claim**: evidence decides only a claim that some run could refute.
2. **Sensitive evidence**: a check is evidence only if it fails when the claim is false. A run that never executed the changed code still reads as success.
3. **Domain coverage**: a claim quantifies over a domain, such as all chains or every restore point. Tests sample less. Line coverage cannot show the gap, because a covered line can hold an untested condition.
4. **Independence**: an author's warm read re-endorses its own choices. A fresh reviewer gets the code, not the author's conclusions.
5. **Bounded loop**: each round's fixes seed the next round's findings, so the count levels off instead of reaching zero. Stop by rule, not by an empty list.
6. **Durable evidence**: a hand run proves a claim once. The next change can break it, and nothing reruns the hand run. A result a deterministic check can hold should end as one.

## Parameters

- `target` (optional): a PR number, a branch, or a `<base>..<tip>` range. Default: the current branch against the default branch.

## Rules

- **The tip, not HEAD.** The tip is the change's last commit. Copy tests from the tip, and expect green on the tip. HEAD may be many commits later, so its tests can fail on the "before" source for unrelated reasons.
- **Run nothing in the checkout.** Every run happens in a throwaway extract (§Throwaway copy). Use no `git worktree`, because the sandbox keeps `.git/worktrees` read-only. Use no stash, reset or checkout, because other sessions may share the folder. Fixes from step 7 are ordinary edits in the checkout; commit them through `/git commit` when the user asks.
- **A run counts only when the claim's tests executed** (§Executed).
- **The right red.** A before-run must fail on an assertion about the claim (§The right red).
- **Never edit a PR body unasked.** Route the section through `/git pr`, or ask before `gh pr edit`.

## Workflow

```
// Resolve the change
if target is a PR number:
    pr = Bash(gh pr view <n> --json state,headRefOid,headRefName,mergeCommit,baseRefName,body,commits)
    branch = pr.headRefName
    if pr.state == MERGED:
        tip = pr.mergeCommit.oid; base = <tip>^1    // main before the merge
        // squash: <tip> has one parent and its subject ends in "(#<n>)"; a merge commit has two
        // neither holds, as after a rebase merge: ask the user for the range
    else:
        tip = pr.headRefOid; base = Bash(git merge-base <tip> origin/<pr.baseRefName>)
else if target is a range: base, tip = the range; branch = "<base, 7 chars>-<tip, 7 chars>"
else:
    branch = target or the current branch; tip = its tip
    base = Bash(git merge-base <tip> origin/<default branch>)
commits = Bash(git log --reverse --format=%H <base>..<tip>)
diff = Bash(git diff <base>..<tip>)

// 0. Gate
if diff changes no behavior (docs, formatting, pure renames):
    report "no behavior claim; the project's checks cover it" and stop

// Repo-local overrides (they beat these rules' preferences, never the forces)
overrides = do("read the repo's CLAUDE.md and AGENTS.md for what verification needs there:
    production paths, the environment tests need to run instead of skip,
    sibling pairs that must agree, the cell fixture for state matrices")
for each override the repo does not name:
    do("discover it from the code; record it under **Assumed:**")
if the needed environment is missing:
    do("say so before running, on the report's first line and on the Assumed line;
        affected claims end unverified (skipped)")

// 1. Claims (Force 1)
sources = do("collect claims from the PR body, the ticket or crux done-conditions,
    and the commit subjects in base..tip; after a squash merge, the PR's own commit subjects")
for each claim:
    sentence = do("restate as one falsifiable sentence — see §Falsifiability test")
    // cover all the source claims: a sentence that covers less keeps the source's words, or splits
    if not falsifiable:
        do("send it back to its author or to /probe; its verdict is unverified")
        continue
    do("record its shape (§Claim shapes), domain, production files and tests")
    claim.before = do("parent of the first commit in `commits` that touches the claim's
        production files")    // a squash merge has one commit, so before == base
unclaimed = do("production files changed in base..tip, minus the files any claim names")
for each unclaimed file:
    do("make it a claim, often invariance, or defer it with a reason")

t = do("extract the tip — see §Throwaway copy; steps 2 to 6 reuse it")

// 2. Red before, green after (Force 2) — skip for invariance claims
for each claim whose shape is not invariance:
    b = do("extract claim.before — see §Throwaway copy")
    do("copy the claim's test files from the tip into b, plus the test helpers they import
        that changed in before..tip")
    if a copied file fails to load in b because it imports what the change added:
        do("trim it to the claim's tests and the imports they use; keep their assertions verbatim;
            record the trimmed file in the Command column")    // §The right red
    red = Bash(<runner> <test files> <filter>, cwd = b)
    do("check red executed (§Executed) and is the right red (§The right red)")
    green = Bash(<runner> <test files> <filter>, cwd = t)
    do("check green executed and passed")

// 3. Condition removal (Force 2)
for each claim:
    conditions = do("each condition added or moved in before..tip in the claim's production files:
        a guard, a comparison, an early return, a `&&` or `||` term, a refusal")
    for each condition:
        do("in t, remove it: make the guard always pass, so its refusal never fires")
        run = Bash(<runner> <claim's tests>, cwd = t)
        do("check run executed; expect red. A crash counts as red: record it as red (crash)")
        do("restore the file from the tip: git archive <tip> <file> | tar -x -C <t>")
        if run is green:
            do("record a survivor: a missing test, or a condition with no ground (route to /justify)")

// 4. Differential (Force 3) — conditional
if claim.shape == agreement or step 1 found a sibling that decides the same predicate
        through the same helper:
    do("follow references/differential.md")

// 5. State matrix (Force 3) — conditional
if claim.shape == state-space:
    do("follow references/matrix.md")

// 6. Review (Force 4)
Bash(git diff <base>..<tip> > <t>.diff)
findings = Agent(general-purpose, prompt = §Reviewer brief filled with the claim sentences,
    the diff path and t)    // claims only: no evidence, no verdicts
if the Agent tool is unavailable: do("write the filled brief to a file, report its path, and stop")
for each finding:
    do("run its reproducing input in t, or in b when it compares with before;
        label it verified or hypothesis")

// 7. Stop (Force 5)
for each finding from steps 2 to 6:
    if it is verified and (the change introduced it or it breaks the change's own paths):
        do("fix it")
    else:
        do("defer it in the section, with a reason")

// Checks (Force 6)
for each result a deterministic check can hold — see §Checks:
    rung = do("the highest rung that can hold it: the code's form, a type,
        a lint or source-scan rule, a test")
    if its finding is fixed in this change:
        do("add the check; prove it red with the finding's removal or input, green at the fix")
    else:
        do("record the check as proposed: its rung and what it asserts")

for each fix:
    do("rerun steps 2 and 3 for its claim only; defer its differential or matrix work, with a reason")
// uncovered behavior from step 6 stays under Review; it becomes no new claim
// there is no second review
done = every claim has a verdict and every review finding is triaged

// Output
section = do("fill §State section")
Bash(mkdir -p "$(dirname "$TMPDIR/verify/<repo>/<branch>.md")")    // a branch name may hold a slash
Write("$TMPDIR/verify/<repo>/<branch>.md", section)    // repo: the git root's folder name; /git pr reads this path
do("show the section in chat; list the extracts left under $TMPDIR")
if the PR is open or not yet opened:
    do("offer to carry the section into the PR body through /git pr")
```

## Reference

### Falsifiability test

A claim is falsifiable if and only if: running the same method on twin systems (identical setup, identical inputs) could produce the opposite verdict. The test fails when the claim is decided by its wording alone (tautology), too vague for any single method to decide it, or asks "is X good" without a measurable criterion.

- Fails: "gap closed". No run can decide it.
- Passes: "`opensWith` and `seed` accept the same chains". A chain one accepts and the other refuses refutes it.

### Claim shapes

The shape picks the methods.

| Shape       | Form                                        | Methods |
| ----------- | ------------------------------------------- | ------- |
| behavior    | "X now does or refuses Y"                   | red→green, condition removal |
| agreement   | "X and X′ accept the same inputs"           | red→green, condition removal, differential |
| state-space | "for every step S and restore R, outcome O" | red→green, condition removal, matrix |
| invariance  | "behavior unchanged" (refactor, moved code) | condition removal on moved or rewritten conditions |

A claim no shape fits, such as a cost claim: name a method that could refute it, or end it `unverified (no method)`.

### Throwaway copy

```bash
dir=$(mktemp -d "$TMPDIR/verify.XXXXXX")
git archive <rev> | tar -x -C "$dir"
```

Install the copy's dependencies inside it, from its own lockfile, with the repo's package manager. For bun: `bun install --cwd "$dir" --frozen-lockfile`. Bun clones packages from its global cache, so the install takes seconds. If the install fails, report why; the claims that need this copy end unverified.

Then check that no link in the copy resolves into the checkout:

```bash
fd -HI -t l . "$dir" -x readlink -f {} | rg -F "$(realpath <checkout>)"
```

Any output is a link into the checkout, such as a symlinked `node_modules`. A run would then import the checkout's code. Remove each such link, install instead, and run the check again.

A hook may refuse `rm -rf` outside the project. List the extracts left in the report, so the user can remove them.

### Executed

Filter the run by claim, never by environment: no filter may leave out a test because it skips. Then read the runner's output:

- the claim's tests appear by name as passed or failed, so the filter matched them;
- errors = 0, because a file that fails to load reports a fail and runs no test;
- skip = 0 for the claim's tests.

A skipped test is neither red nor green. Its verdict is "unverified (skipped)", never a survivor. Name the missing environment beside it. A condition that survives while some of the claim's tests skipped is a `survivor (n skipped)`, and its claim cannot reach confirmed.

### The right red

The before-run must fail on an assertion about the claim. A compile error, an import error or a missing export proves nothing. Record it as "wrong red". Then this method cannot confirm the claim, so its verdict is at best partial.

A test from the tip may name an error code, export or helper the before source lacks. Read each failure before counting it.

When the claim's own test calls what the change added, no right red is possible: record that, and the claim ends partial at best.

### Reviewer brief

Fill and send verbatim:

```
Refute these claims about a change. They are hypotheses, not findings.
For each claim, hunt for an input or state under which it is false.
Also list changed behavior inside the claimed files that no claim covers.

Claims:
C1 <sentence>
C2 <sentence>

Diff: <path to the base..tip diff>
Code: <path to the tip extract>. Read it; run anything there.
Keep every edit and scratch file inside it, and restore what you change.

Return one finding per line:
<C-id or "uncovered"> — <what fails> — reproducing input: <exact input, state or command>
A finding without a reproducing input is a hypothesis: mark it so.
Write "none" for a claim you could not refute.
```

### Checks

A deterministic check gives the same pass or fail on every run, with no judgment. A result can become one when it has an oracle: an input with a known output, a state with a named refusal, or a structural rule a scan can read.

If you would explain a constraint in a comment, a higher rung was missed.

| Result                                                        | Usual check |
| ------------------------------------------------------------- | ----------- |
| survivor                                                      | a test that goes red with that condition removed |
| refuted claim, or a verified finding with a reproducing input | a regression test on that input |
| disagreement between siblings                                 | one shared function both call, or a test that feeds every disagreement input to both |
| matrix cell that ran                                          | a parameterized test over the repo's cell fixture |
| probe run outside the test runner                             | the same probe inside the runner; name the seam it needs when the repo blocks it |
| hand mutation                                                 | a mutation-testing gate, once the repo wires one |

No deterministic check fits a cost or timing claim, a prose-only finding, or a hypothesis without a reproducing input. Record `none` with the reason.

### Verdicts

- `confirmed`: every applicable method ran, could have failed, and left no survivor.
- `refuted`: a run produced a counterexample. One inferred from code is a hypothesis under Review.
- `partial`: some methods or matrix cells did not run, or a removed condition survived.
- `unverified`: no method could run, no method fits the claim, or the claim's test skipped.

"Unverified" is a legal ending when the section says so.

### State section

The marker line names the tip the section verified, so `/git pr` can tell a stale section by comparing it with HEAD.

```markdown
## Verification
<!-- verify: tip <sha> -->

| Claim | Shape | Method | Command | Result | Verdict |
| --- | --- | --- | --- | --- | --- |
| C1 <sentence> | <shape> | <method> | `<exact command>` at `<rev>` | `<output tail>` | <verdict> |

**Matrix:** rows are steps, columns are the restored side; each cell is ok, `<refusal>`, or unrun.

**Survivors:** `<file:line>` <condition> — missing test | no ground.

**Disagreements:** <input> — <A> accepts, <B> rejects — bug | intended.

**Unclaimed:** <file or behavior> — claim <Cn> | deferred: <reason>.

**Review:** <finding> — verified | hypothesis — fixed | deferred: <reason>.

**Checks:** <result> — <rung>: <file or rule> — added (red with <removal or input>, green at `<rev>`) | proposed | none: <reason>.

**Assumed:** <override the repo does not name> — <what was used>.
```

Keep every line. Write "none" when its step ran and found nothing, and "not run: <reason>" when it did not run.
