# Clear Writing — Full Reference

Sources: Orwell ("Politics and the English Language"), Williams ("Style: Lessons in Clarity and Grace"), plainlanguage.gov, RareSkills.

## Actors & Actions

### Make the actor the subject

Ask: who does what? Make "who" the subject. Readers parse faster when a concrete character drives the action.

| Before                                           | After                                          |
| ------------------------------------------------ | ---------------------------------------------- |
| An investigation was conducted by the team.      | The team investigated.                         |
| The establishment of a committee is recommended. | We recommend establishing a committee.         |
| Failure to comply will result in penalties.      | If you fail to comply, you will pay penalties. |

**Diagnostic:** look at the first 7 words. If there is no specific character — revise.

### Express actions as verbs

Turn nominalizations back into verbs. Suffixes like -tion, -ment, -ance bury the action and bloat the sentence.

| Before                                                                         | After                                   |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| We conducted an analysis of the data.                                          | We analyzed the data.                   |
| The committee performed an evaluation of the program.                          | The committee evaluated the program.    |
| The intention of the company is the achievement of the maximization of profit. | The company intends to maximize profit. |

**Diagnostic (Williams):** look at the first 7–8 words. If you find abstract nouns where verbs should be and no specific agent — revise.

### Use active voice

Active voice shows who does what. Reserve passive for when the actor is unknown or irrelevant.

| Before                                | After                          |
| ------------------------------------- | ------------------------------ |
| New regulations were proposed.        | We proposed new regulations.   |
| The lake was polluted by the company. | The company polluted the lake. |
| The feature was shipped.              | The team shipped the feature.  |

**Exception:** passive is fine when the actor is unknown or unimportant: "The server was rebooted at 3 AM."

## Word Choice

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

### Invent fresh comparisons

When you need a figure of speech, create one that produces a visual image. Dead metaphors ("level playing field", "at the end of the day") are invisible to the reader.

| Before                | After                         |
| --------------------- | ----------------------------- |
| think outside the box | (say what you actually mean)  |
| a level playing field | equal starting conditions     |
| move the needle       | increase signups by 10%       |
| low-hanging fruit     | tasks that take under an hour |

**Orwell's procedure:** think wordlessly first, visualize the thing, then hunt for words that fit.

## Sentence Shape

### Split and reconnect

A sentence should carry one idea. But splitting can produce disconnected fragments. So this is a loop:

```
loop:
  for each sentence:
    while sentence has more than one idea:
      split → target 15–25 words per piece
  for each adjacent pair:
    if they describe the same thing but feel unrelated:
      reconnect
      if reconnected sentence overloaded:
        rephrase with a different technique
        if still overloaded after 2 attempts:
          show both variants to user → stop
      go to loop
```

**Split examples:**

| Before                                                                                                                                                  | After                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| These sections describe types of information that would satisfy the application requirements of Circular A-110 as it would apply to this grant program. | These sections tell you how to meet the requirements of Circular A-110 for this grant program.                 |
| The system processes requests quickly and reliably, while also handling error cases and logging them to the monitoring service for later review.        | The system processes requests quickly and reliably. It logs errors to the monitoring service for later review. |

**Reconnect examples:**

| Before                                                                           | After                                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Single-file HTML asset tracker. Double-entry bookkeeping, treemap visualization. | A single-file HTML asset tracker with double-entry bookkeeping and treemap visualization. |
| Git tracks structure and skills only. Content syncs via livesync.                | Git tracks structure and skills only — content syncs via livesync.                        |
| Files accumulate. I sometimes revisit them. Synced via Syncthing.                | Files accumulate and sync via Syncthing. I sometimes revisit them.                        |
| A set of small repos, each doing one thing. (floating after previous paragraph)  | The result is a set of small repos, each doing one thing.                                 |

**Reconnection techniques:**

- **Conjunction** — "and", "so", "but" merge two short sentences into one
- **Shared subject** — carry "it" or "the system" forward instead of starting fresh
- **Reference back** — "the result is", "on top of that", "this" ties to the previous sentence
- **Clause merge** — make one sentence a clause of the other ("a tracker with X and Y" instead of "a tracker. X. Y.")
- **Dash or semicolon** (last resort) — only when the above techniques don't fit. No two dashes within 3 sentences.

Source: Williams principle 5 (cohesion)

### Get to the main verb within 7 words

Keep the subject short and place it early. Long openings before the main verb force the reader to hold too much in memory.

| Before                                                                              | After                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The evaluation of the program by the committee resulted in a recommendation.        | The committee evaluated the program and recommended changes. |
| A number of issues that were raised during the review process need to be addressed. | The review raised several issues. We need to address them.   |

**Diagnostic:** count words before the main verb. More than 7? Move the subject closer to the front and shorten it.

### Open with familiar, close with new

Start with what the reader knows. End with new, complex information. The end position carries emphasis.

| Before                                                                | After                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A completely redesigned query engine powers the new version.          | The new version is powered by a completely redesigned query engine. |
| Unexpected latency spikes are what the monitoring dashboard revealed. | The monitoring dashboard revealed unexpected latency spikes.        |

**Cohesion:** end one sentence with info that begins the next. This creates flow between sentences.

## Passage Structure

### Start with the main point

Lead with the answer, then explain.

| Before                                                                                                                                       | After                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Taking into account all the factors, including cost, timeline, and risk, we concluded that migrating to the new platform is the best option. | We should migrate to the new platform. Cost, timeline, and risk are acceptable. |
| There are many factors that affect system performance. One of them is caching.                                                               | Caching improves system performance.                                            |

### One topic per paragraph

Each paragraph develops one idea. Start with a topic sentence, then add details, examples, or evidence.

| Before                                                            | After                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| A single paragraph covering architecture, testing, and deployment | Three paragraphs: architecture, testing, deployment      |
| A 15-sentence paragraph about everything                          | Three paragraphs of 3–5 sentences, each about one aspect |

**Structure:** topic sentence → supporting details → (optional) transition to next paragraph.

### Use informative headings

Make headers meaningful on their own. If someone only reads the headings, they should understand the document's structure and main points.

| Before       | After                      |
| ------------ | -------------------------- |
| Introduction | Why We Recommend Migration |
| Background   | Current System Limitations |
| Discussion   | Three Migration Options    |
| Conclusion   | Timeline and Next Steps    |

**Test:** read only the headings. Can you understand the document without the body text?

### Sort by information dependency

Explain prerequisites before the things that depend on them.

| Before                                                                                                                                           | After                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| The function calls `validate()` to check inputs. [...paragraphs later...] The `validate()` function checks that all required fields are present. | The `validate()` function checks that all required fields are present. The main function calls `validate()` to check inputs. |
| Install the CLI tool. First, make sure you have Node.js installed.                                                                               | First, install Node.js. Then install the CLI tool.                                                                           |

## Reader Focus

### Write for your specific audience

Use language your readers know. Match vocabulary, examples, and level of detail to the audience. A developer guide and a user manual for the same feature should read differently.

| Before                                                                                                  | After                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The system leverages a distributed architecture to ensure high availability. (to non-technical readers) | The system runs on multiple servers so it stays online even if one fails. |
| Click the button to submit. (to developers)                                                             | Call `POST /api/submit` with the form payload.                            |

### Tell the reader why they should care

Open with a problem the reader recognizes. Motivate every fact by connecting it to something the reader needs or wants.

| Before                                         | After                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| This document describes the new caching layer. | The new caching layer cuts page load time by 60%. Here's how it works. |
| We updated the deployment pipeline.            | Deployments now take 3 minutes instead of 20. Here's what changed.     |

**Test:** after each fact, ask "so what?" If you can't answer from the reader's perspective, add the connection or cut the fact.

### Minimize what the reader holds in memory

Repeat past information where needed instead of forcing the reader to remember it. Do the math for them. Use obvious examples.

| Before                                                   | After                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| As mentioned in Section 2, the token limit applies here. | The token limit (4096 tokens) applies here.                                 |
| Token A costs 0.003 per unit. With 1000 units...         | Each token costs $0.003. For 1000 tokens, that's $3.00.                     |
| The function described earlier handles this case.        | The `validate()` function (which checks required fields) handles this case. |

**Principle:** summarize prerequisites inline rather than linking out. Context switches cost the reader's attention.

### Define terms when introduced

Define every new term the first time it appears, even if a full explanation comes later. Use the same term consistently — synonyms for key concepts create confusion.

| Before                                                                                       | After                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The service uses idempotent operations. [...pages later...] Idempotent means safe to repeat. | The service uses idempotent operations (safe to repeat without side effects). |
| The worker... the processor... the handler... (same thing, three names)                      | The worker... the worker... the worker...                                     |

## AI Patterns

### Start with the substance

Cut filler transitions that delay the real content. If something matters, explain why — the explanation proves the importance. The reader came for substance, not ceremony.

| Before                                                                      | After                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| It is important to note that the API rate limit is 100 requests per minute. | The API rate limit is 100 requests per minute.              |
| Here's how we can solve this problem:                                       | (just describe the solution)                                |
| In this section, we will explore the concept of caching.                    | Caching stores frequently accessed data closer to the user. |

**Common filler:** "It is important to note", "It is worth mentioning", "Here's how", "Let's explore", "In this section, we will discuss".

### Replace promotional adjectives with facts

Promotional adjectives say nothing measurable. Replace each with a fact, number, or comparison.

| Before                       | After                                                     |
| ---------------------------- | --------------------------------------------------------- |
| Our innovative solution      | Our solution reduces build time from 20 minutes to 3      |
| A groundbreaking approach    | An approach first used in production at Company X in 2024 |
| Highly scalable architecture | Handles 50,000 concurrent connections                     |
| Cutting-edge technology      | Uses WebTransport (standardized in 2023)                  |

**Words to replace:** novel, innovative, groundbreaking, game-changing, cutting-edge, transformative, pioneering, scalable, empowering, robust.

### Vary sentence length and structure

AI text is predictable: medium-length sentences, every paragraph opens with a generalization, excessive "balance" ("on one hand... on the other"). Break the pattern.

| Before                                                                                       | After                                                                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Every sentence is 15–20 words. Every sentence is 15–20 words. Every sentence is 15–20 words. | Mix lengths. Some sentences are short. Others stretch out to carry a more complex idea across the line. |
| On one hand X, on the other hand Y. (when the answer is clear)                               | X.                                                                                                      |
| Furthermore... Additionally... Moreover...                                                   | (remove the connectives if the logic already flows)                                                     |

**Techniques:** follow a long explanation with a short sentence. Start one paragraph with a question, another with a fact, another with an example.

### Match punctuation to emphasis

Colon, dash, and parentheses interrupt at three levels of emphasis. Pick the one that fits.

| Before                                                                | After                                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| The system (built in just two weeks) handles 10k requests per second. | The system — built in just two weeks — handles 10k requests per second. |
| The system has one flaw, it cannot recover from crashes.              | The system has one flaw: it cannot recover from crashes.                |
| Three teams, backend, frontend, and SRE, reviewed the design.         | Three teams — backend, frontend, and SRE — reviewed the design.         |
| The response time improved; however the error rate stayed the same.   | The response time improved. The error rate stayed the same.             |

**Emphasis scale:**

- **Colon** — formal announcement: "here is what I mean"
- **Dash** — casual or dramatic aside
- **Parentheses** — minimized aside, feels unimportant

**When the aside has internal commas, use dashes** instead of commas to avoid ambiguity.

**Semicolons** link two closely related sentences when the first is short (under ~15 words). If you need a semicolon because the sentence is long, split it with a period instead.
