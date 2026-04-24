---
name: affirm
description: >
  Rewrite negative instructions as positive directives and remove hedging language.
  Use when user invokes /affirm or asks to make instructions direct, remove hedging,
  flip negatives to positives, or strengthen language in skill files, docs, or prompts.
  Works on inline text, files, or conversation context.
---

# Affirm

Rewrite instructions as direct positive statements. Remove hedging.

## Parameters

- `text` (required): The text to rewrite. Inline text, file path, or conversation context.

```
text = parse text from arguments or conversation context
if no text provided: AskUserQuestion("What text should I rewrite?")

// Pass 1: Flip negatives
do("find sentences with 'do not', 'don't', 'never', 'avoid', 'no', 'not'")
do("rewrite each to state the desired behavior directly")

// Pass 2: Collapse double negatives
do("find double negatives: 'not uncommon', 'not unlikely', 'not insignificant', 'not without'")
do("replace with the direct positive: 'common', 'likely', 'significant', 'with'")

// Pass 3: Remove hedging
do("find hedging words: 'might', 'perhaps', 'consider', 'try to', 'should probably', 'it seems', 'be careful to', 'make sure to', 'ensure that'")
do("replace each with direct instructions")

// Pass 4: Strip permission framing
do("find permission patterns: 'you can', 'you may', 'feel free to', 'you are allowed to'")
do("replace with imperative: 'use X' instead of 'you can use X'")

// Pass 5: Remove vacuous conditionals
do("find 'if applicable', 'when appropriate', 'as needed', 'where possible'")
do("if the condition is always true in context, remove it")
do("if the condition is genuinely conditional, leave it")

// Pass 6: Verify
do("check that meaning is preserved — positive framing changes phrasing, not intent")
do("check that scale descriptions and genuine uncertainty markers are left intact")

// Output
do("show before/after for each changed sentence")
```

## Reference

### Negative to positive

The model reads "do X" in one inference step. "Do not do Y" requires two: parse Y, then invert. Positive framing resolves in one step and leaves less room for misinterpretation.

| Before                                | After                                              |
| ------------------------------------- | -------------------------------------------------- |
| Do not use mocks in integration tests | Use real database connections in integration tests |
| Never commit secrets                  | Keep secrets out of version control                |
| Avoid long functions                  | Split functions at natural boundaries              |
| Don't repeat yourself                 | Extract shared logic into a single location        |

Keep negatives when the positive form loses precision. "This function returns null on failure" says more than "This function returns a value on success."

### Hedging to direct

Hedging signals optionality. The model reads "consider X" as "X is one possibility among many" and may skip it. Direct instructions close that gap.

| Before                           | After                                       |
| -------------------------------- | ------------------------------------------- |
| You might want to check the logs | Check the logs                              |
| Consider using a cache here      | Use a cache here                            |
| Try to keep functions short      | Keep functions short                        |
| Make sure to validate input      | Validate input                              |
| Be careful not to break the API  | Preserve the API contract                   |
| Be honest about uncertainty      | Calibrate grades to match actual confidence |

Preserve hedging in scale descriptions and genuine conditional uncertainty ("if the data is unavailable, the result may be incomplete"). These describe reality, not instructions.

### Double negatives

Two negations require two inversions to reach the meaning. Replace with the direct positive.

| Before               | After          |
| -------------------- | -------------- |
| not uncommon         | common         |
| not unlikely to fail | likely to fail |
| not without risk     | risky          |
| not insignificant    | significant    |

### Permission framing to imperative

In instruction context, "you can" signals optionality. The model treats optional steps as skippable. Use imperative form.

| Before                               | After                        |
| ------------------------------------ | ---------------------------- |
| You can use SQLite for local caching | Use SQLite for local caching |
| Feel free to split the function      | Split the function           |
| You may want to add a timeout        | Add a timeout                |

Preserve permission framing in user-facing text where the user genuinely has a choice ("You can override this with --force").

### Vacuous conditionals

"If applicable" and "when appropriate" create an escape hatch. When the condition is always true in context, the qualifier adds nothing. Remove it.

| Before                        | After              |
| ----------------------------- | ------------------ |
| Validate input, if applicable | Validate input     |
| Use caching where possible    | Use caching        |
| Add error handling as needed  | Add error handling |

Preserve genuinely conditional qualifiers where the condition is sometimes false ("if the user provides a file path, read it").
