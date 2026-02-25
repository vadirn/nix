# Pass 1: Words

## Pseudocode

```
for each word/phrase in text:
  if noun carries an action (nominalization: -tion, -ment, -ance):
    replace with the verb form  // Express actions as verbs
  if a shorter word carries the same meaning:
    replace with the shorter word  // Choose the shortest word
  if word adds no meaning (filler, doubled word, inferable word):
    cut it  // Cut every word you can
  if negative construction:
    replace with affirmative equivalent  // Use affirmative form
  if dead metaphor (cliché figure of speech):
    invent a concrete image or say what you mean  // Invent fresh comparisons
  if formal/Latin word with a plain equivalent:
    replace with everyday English  // Use everyday English
```

## Rules

### Express actions as verbs

Turn nominalizations back into verbs. Suffixes like -tion, -ment, -ance bury the action and bloat the sentence.

| Before                                                                         | After                                   |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| We conducted an analysis of the data.                                          | We analyzed the data.                   |
| The committee performed an evaluation of the program.                          | The committee evaluated the program.    |
| The intention of the company is the achievement of the maximization of profit. | The company intends to maximize profit. |

**Diagnostic (Williams):** look at the first 7–8 words. If you find abstract nouns where verbs should be and no specific agent — revise.

### Choose the shortest word that carries your meaning

Short words read faster and resist misunderstanding.

| Before        | After |
| ------------- | ----- |
| utilize       | use   |
| facilitate    | help  |
| approximately | about |
| commence      | start |
| subsequently  | then  |

### Cut every word you can

Remove words that add no meaning. If the sentence works without a word, cut it.

| Before                                         | After             |
| ---------------------------------------------- | ----------------- |
| It is important to note that the system fails. | The system fails. |
| due to the fact that                           | because           |
| in the event that                              | if                |
| each and every                                 | every             |
| full and complete                              | complete          |

**Categories to cut:** meaningless words ("kind of", "actually", "basically"), doubled words ("full and complete"), inferable words ("anticipate in advance" → "anticipate"), phrases replaceable by a single word ("due to the fact that" → "because").

### Use affirmative form

Negatives force the reader to picture an action and then cancel it. Affirmatives give the right picture immediately.

| Before           | After             |
| ---------------- | ----------------- |
| not different    | similar           |
| not many         | few               |
| did not remember | forgot            |
| not able to      | unable to / can't |
| not possible     | impossible        |

**Double negatives:** "not uncommon" → "common". "not impossible" → "possible".

### Invent fresh comparisons

When you need a figure of speech, create one that produces a visual image. Dead metaphors ("level playing field", "at the end of the day") are invisible to the reader.

| Before                | After                         |
| --------------------- | ----------------------------- |
| think outside the box | (say what you actually mean)  |
| a level playing field | equal starting conditions     |
| move the needle       | increase signups by 10%       |
| low-hanging fruit     | tasks that take under an hour |

**Orwell's procedure:** think wordlessly first, visualize the thing, then hunt for words that fit.

### Use everyday English

Use words your audience already knows. Save technical terms for when no everyday equivalent exists.

| Before     | After      |
| ---------- | ---------- |
| utilize    | use        |
| terminate  | end        |
| sufficient | enough     |
| prior to   | before     |
| endeavor   | try        |
| in lieu of | instead of |

**Edge case:** when writing for specialists, use their standard terms. "Idempotent" is clearer than "safe to repeat" for a developer audience.
