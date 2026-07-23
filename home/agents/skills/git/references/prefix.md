# Prefix selection

The single naming rule for commits, branches, and PR titles. Every subcommand reads this file.

**Contract** = what the code promises its outermost audience: end-users for a product, callers for a library.

In the contract:

- Inputs accepted, outputs produced, errors raised, externally-visible side effects.
- Type signatures (in typed languages).
- Documented behavior, plus behavior that tests, types, or other callsites in this repo rely on.
- Implicit safety promises every system makes: no data leaks, no crashes on malformed input, no privilege escalation.

Outside the contract: speed, memory use, internal structure, log/metric/trace format (unless documented as a stability surface).

Ask three questions in order; stop at the first "yes":

1. Was the contract violated before this change, and now honored? → `fix`
2. Does this change the contract (add, alter, or remove what's promised)? → `feat`
3. Otherwise → `chore`

`chore` is the default — most changes (refactor, perf, deps, config, internal docs, tests, migrations, i18n) sit below the contract line. `feat` and `fix` are reserved for changes that cross it, so they carry information: a `feat` commit means callers might need to react; a `fix` commit means a promise that was being violated is now honored.

Read `prefix-examples.md` when a call is unclear; it holds the worked example bank.

## Unit of the prefix

The three subcommands apply the same test to different units, so a branch prefix is never inherited from a commit.

- **Commit** — the one change being recorded. **One concern per commit**: split unrelated concerns even when they share a prefix — three `chore`s touching different subsystems are three commits, not one — and split a change that crosses the contract line in multiple ways. A revert is always its own concern: never fold it into another commit, or the undo hides inside an unrelated subject.
- **Branch** — the net change the branch delivers when merged, taken as a whole. A branch holds many commits and they need not share a prefix: a `feat` branch routinely contains `chore` refactors and a stray `fix`.
- **PR** — the same unit as its branch. The PR title becomes the commit message on squash-and-merge, so it carries the branch's prefix. Squash flattens the whole branch into that one line on `main`, which makes the PR the atomic unit that actually lands: keep a PR to one concern (a feature and its enabling refactors are one concern; three unrelated chores are three), and keep a revert in its own PR. A revert folded into a multi-concern PR hides under the roll-up title and can silently clobber a sibling change — the failure this rule exists to prevent.
