# Differential test

Serves Force 3, domain coverage. Two units that decide the same predicate must agree on every input. Tests of each unit sample its own domain, so a check one makes and the other skips goes unseen.

Run it for an agreement claim, or when step 1 finds a sibling: another unit that decides the same predicate through the same helper.

## Steps

1. Name the pair and the predicate: "X and X′ accept the same <inputs>". Find the helper both call.
2. Read both. Tabulate every check, including those before the shared helper, the arguments each passes into it, and those after it:

   | Check       | X   | X′ |
   | ----------- | --- | --- |
   | <predicate> | yes | no |

3. For each row where only one side checks, build one input that fails only that check. Start from a fixture both accept, and change one field.
4. Feed each input to both through their public entry points, in the tip extract. Record which accepts and which refuses, with the refusal's reason.
5. Classify each disagreement:
   - **intended** only when a comment, doc or recorded decision states the difference;
   - **bug** otherwise. A bug goes to step 7's triage as a verified finding.

## Record

```markdown
**Disagreements:** <input> — <A> accepts, <B> rejects — bug | intended.
```

## Example

A capture check and a replay check open the same chain through one helper. If only the replay check compares the opening's project and generation, capture accepts chains replay refuses. The fix moves both onto one opening check.
