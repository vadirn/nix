# English writing passes — reference for the embedded rubric in cut.ts

The condensed rubric in `cut.ts` (RUBRIC_EN) is derived from these four passes. This file is the full source; edit it, then re-distill into the constant.

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
  if negative construction (negation or "X, not Y" contrast):
    replace with affirmative equivalent  // Use affirmative form
  if dead metaphor (cliché figure of speech):
    replace with a literal statement of what you mean  // Replace dead metaphors with literal statements
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

**Contrast negation** ("X, not Y" and "Not X, but Y"): rephrase so "not" disappears.

| Before                       | After                        |
| ---------------------------- | ---------------------------- |
| X improved, not Y            | Only X improved              |
| We chose X, not Y            | We chose X instead of Y      |
| Use X, not Y                 | Use X rather than Y          |
| X changed, not Y             | Y stayed the same; X changed |
| Not a sprint, but a marathon | A marathon                   |
| Not theory, but practice     | Practice                     |

### Replace dead metaphors with literal statements

Dead metaphors ("level playing field", "at the end of the day") pass unnoticed and obscure meaning. Replace them with a literal statement of what you mean. Stick to literal statements.

| Before                | After                         |
| --------------------- | ----------------------------- |
| think outside the box | (say what you actually mean)  |
| a level playing field | equal starting conditions     |
| move the needle       | increase signups by 10%       |
| low-hanging fruit     | tasks that take under an hour |

**Diagnostic:** if the metaphor can be removed and replaced with the concrete fact it points to, replace it.

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

# Pass 2: Sentences

## Pseudocode

```
for each sentence:
  if subject is not the actor (agent buried elsewhere or absent):
    move the actor to subject position  // Make the actor the subject
  if verb is passive and actor is known:
    rewrite as active  // Use active voice
  if words before main verb > 7:
    shorten or front the subject  // Get to the main verb within 7 words
  if sentence opens with new/complex info:
    move familiar info to front, new info to end  // Open with familiar, close with new
  if sentence has no main verb and uses contrast markers (but, not, yet) to imply meaning:
    rewrite with a subject and verb that state the point  // Replace verbless fragments

// Cohesion between sentences (known-new contract, Williams)
for each paragraph:
  for each adjacent pair (sentence N, sentence N+1):
    topic_N1 = subject/topic of sentence N+1
    end_N = new information at the end of sentence N
    if topic_N1 does not pick up end_N and does not repeat topic_N:
      rewrite: move known info to the start of N+1, new info to the end  // Chain known→new across sentences
  topics = [subject of each sentence in the paragraph]
  if topics jump (each sentence starts with a different subject):
    rewrite with a consistent topic or merge sentences  // Keep consistent topics in a paragraph

// Split and reconnect loop
loop:
  for each sentence:
    while sentence carries more than one idea:
      split → target 15–25 words per piece  // Split and reconnect
  for each adjacent pair of sentences:
    if they describe the same thing but feel disconnected:
      reconnect using: conjunction / shared subject / reference back / clause merge / dash or semicolon
      if reconnected sentence is overloaded:
        rephrase with a different technique
        if still overloaded after 2 attempts:
          keep the simpler of the two variants and continue
      go to loop
```

## Rules

### Make the actor the subject

Ask: who does what? Make "who" the subject. Readers parse faster when a concrete character drives the action.

| Before                                           | After                                          |
| ------------------------------------------------ | ---------------------------------------------- |
| An investigation was conducted by the team.      | The team investigated.                         |
| The establishment of a committee is recommended. | We recommend establishing a committee.         |
| Failure to comply will result in penalties.      | If you fail to comply, you will pay penalties. |

**Diagnostic:** look at the first 7 words. If there is no specific character — revise.

### Use active voice

Active voice shows who does what. Reserve passive for when the actor is unknown or irrelevant.

| Before                                | After                          |
| ------------------------------------- | ------------------------------ |
| New regulations were proposed.        | We proposed new regulations.   |
| The lake was polluted by the company. | The company polluted the lake. |
| The feature was shipped.              | The team shipped the feature.  |

**Exception:** passive is fine when the actor is unknown or unimportant: "The server was rebooted at 3 AM."

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

**Diagnostic:** underline the topic (beginning) and new info (end) of each sentence. Cohesion holds when the beginning of N+1 picks up the end of N.

### Chain known→new across sentences

The end of sentence N introduces new information. The beginning of sentence N+1 picks it up as known. This creates a chain that carries the reader forward (known-new contract, Williams Lesson 5).

| Before                                                                         | After                                                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Half-life is 5–7 hours. Caffeine 6 hours before bed cuts sleep by 45 min.      | Half-life is 5–7 hours, so caffeine 6 hours before bed cuts sleep by 45 min.                     |
| To fall asleep, the body drops 1–3°F. Warm extremities speed heat loss.        | To fall asleep, the body drops 1–3°F, and warm extremities speed this process.                   |
| Overhead light is worst: melanopsin sits in the lower retina. Use table lamps. | Overhead light is worst because melanopsin sits in the lower retina, so use table lamps instead. |

**Diagnostic:** for each adjacent pair, check: does the start of N+1 refer to the end of N? If not, rewrite or merge.

### Keep consistent topics in a paragraph

Sentences in one paragraph start from the same topic or a variation of it. When every sentence introduces a new subject (A, B, C, D), the reader loses the thread.

| Before                                                                                        | After                                                                                                    |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The bed is only for sleep. If you can't fall asleep in 15–20 min, get up. Return when sleepy. | The bed is only for sleep. If you can't fall asleep in 15–20 min, leave the room and return when sleepy. |

**Diagnostic:** list the subject of each sentence. If they all differ, rewrite with a shared subject or merge.

Source: Williams, Style: Lessons in Clarity and Grace, Lesson 5 "Cohesion and Coherence", principles 4, 6, 7.

### Replace verbless fragments

Fragments without a main verb that lean on contrast markers (but, not, yet) to carry meaning. The reader has to reconstruct the missing verb. Say what happened instead of gesturing at it.

| Before                                                       | After                                 |
| ------------------------------------------------------------ | ------------------------------------- |
| Real progress, but in the prompt environment, not the model. | Only the prompt environment improved. |
| Good results, but only locally.                              | Results improved locally.             |
| More features, less stability.                               | Adding features reduced stability.    |
| Fast, but fragile.                                           | It runs fast but breaks easily.       |

**Diagnostic:** if the sentence has no conjugated verb, add one. Pick the verb that says what actually changed.

### Split and reconnect

A sentence should carry one idea. But splitting can produce disconnected fragments. So this is a loop.

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
- **Semicolon** (last resort) — only when the above techniques don't fit and both clauses are short.

Source: Williams principle 5 (cohesion)

# Pass 3: Paragraphs

## Pseudocode

```
for each paragraph:
  if main point is buried (conclusion comes after buildup):
    move main point to first sentence  // Start with the main point
  if paragraph covers more than one topic:
    split into separate paragraphs, one topic each  // One topic per paragraph

for each heading:
  if heading is generic (Introduction, Background, Discussion):
    rewrite to state the actual point  // Use informative headings

for the document as a whole:
  if a concept is used before it is explained:
    reorder: move the definition/explanation before first use  // Sort by information dependency
```

## Rules

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

**Structure:** topic sentence → supporting details → (optional) end with a detail the next paragraph can pick up, or open the next paragraph by referencing the previous one's conclusion.

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

# Pass 4: AI Patterns

These patterns share one cause: the model regresses to the statistical mean, smoothing specific facts into generic, important-sounding prose. One test catches most of them. Ask of each sentence: could this apply to almost any subject? If yes, cut it or replace it with something true only of this subject.

## Pseudocode

```
for each sentence:
  if sentence opens with filler ("It is important to note", "Here's how", "In this section"):
    cut the opener, start with the substance  // Start with the substance

for each adjective or modifier:
  if adjective is promotional (innovative, groundbreaking, scalable, robust):
    replace with a fact, number, or comparison  // Replace promotional adjectives with facts

for the text as a whole:
  if all sentences are similar length (uniform 15–20 words):
    vary: add short punchy sentences, let some stretch longer  // Vary sentence length and structure
  if connectives are redundant ("Furthermore", "Additionally", "Moreover"):
    remove them if logic already flows without them  // Vary sentence length and structure

for each punctuation choice:
  if aside is parenthesized:
    if aside has a verb: split into separate sentence  // Match punctuation to emphasis
    else: keep parentheses  // Match punctuation to emphasis
  if two clauses need a formal link:
    use colon  // Match punctuation to emphasis
  if semicolon joins a long sentence:
    split with a period instead  // Match punctuation to emphasis

for each sentence:
  if it asserts broad importance/legacy/trend, or ends with an editorializing "-ing" clause:
    cut it, or replace with a specific sourced fact  // Cut significance inflation
  if a copula was replaced (serves as / represents / boasts / features):
    restore "is" or "has"  // Restore the plain copula
  if "not just X, but Y" / "it's not X, it's Y" / a reflexive triple:
    state the real claim directly; trim the triple to what is true  // Cut canned constructions

for each word:
  if it is in the AI-vocabulary set and the set clusters here:
    prefer the plain verb (has, shows, uses, supports)  // Thin out AI vocabulary
  if attribution is vague ("experts argue", "several sources"):
    name the source and its exact claim, or cut  // Thin out AI vocabulary
  if a synonym was swapped only to avoid repeating a word:
    repeat the plain word  // Thin out AI vocabulary

guard:
  keep simple is/has, plain words, and true superlatives; a single instance is not a tell  // Preserve what is clear and human
```

## Rules

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

Use periods, colons, or parentheses instead of em-dashes. AI-generated text leans on em-dashes as a crutch for loose thinking.

| Before                                                                | After                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The system (built in just two weeks) handles 10k requests per second. | The system handles 10k requests per second. It was built in two weeks. |
| The system has one flaw, it cannot recover from crashes.              | The system has one flaw: it cannot recover from crashes.               |
| Three teams, backend, frontend, and SRE, reviewed the design.         | Three teams (backend, frontend, and SRE) reviewed the design.          |
| The response time improved; however the error rate stayed the same.   | The response time improved. The error rate stayed the same.            |

**Alternatives to em-dashes:**

- **Split into two sentences** when the aside carries its own idea
- **Colon** for announcements: "here is what I mean"
- **Parentheses** for inline lists and asides under ~8 words that lack their own verb. If the aside carries a separate idea, split into a sentence.
- **Commas** when the clause is short and unambiguous

**Semicolons** are acceptable only as a last resort when both clauses are short (see Pass 2). If either clause is long, split with a period.

### Cut significance inflation

Padding that asserts importance, legacy, or a broader trend says nothing about the subject. Delete it, or replace it with a specific sourced fact. A trailing "-ing" clause that editorializes is the same move at clause scale.

| Before                                                                                      | After                         |
| ------------------------------------------------------------------------------------------- | ----------------------------- |
| Founded in 1989, it marked a pivotal moment in the evolution of regional statistics.        | Founded in 1989.              |
| The station has eight tracks, contributing to the socio-economic development of the region. | The station has eight tracks. |
| This etymology highlights the enduring legacy of the community's resistance.                | (cut)                         |

**Words to watch:** stands/serves as a testament, a pivotal/vital/crucial moment, reflects a broader, underscores its significance, leaves an indelible mark, marks a turning point, setting the stage for.

### Restore the plain copula

The model swaps `is` and `has` for heavier verbs. Put them back.

| Before                                                    | After                                              |
| --------------------------------------------------------- | -------------------------------------------------- |
| Gallery 825 serves as the association's exhibition space. | Gallery 825 is the association's exhibition space. |
| The mall boasts over 200 stores.                          | The mall has over 200 stores.                      |
| The festival represents one of the region's largest.      | The festival is one of the region's largest.       |

**Swaps to reverse:** serves as / stands as / represents → is; boasts / features / offers / maintains → has.

### Cut canned constructions

Two reflexive shapes. Negative parallelism ("not just X, but Y"; "it's not X, it's Y") sets up a strawman to knock down. The rule of three pads one idea with two near-synonyms. State the real point directly; keep only the items that are true.

| Before                                                                   | After                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------- |
| The portrait is not just a self-image, but a document of her obsessions. | The portrait documents her obsessions.              |
| A clear, concise, and compelling summary.                                | A clear summary.                                    |
| The platform is fast, reliable, and scalable.                            | The platform handles 50,000 concurrent connections. |

### Thin out AI vocabulary

A recurring word set marks AI text by its density, not any single use. Where the set clusters, prefer the plain verb (has, shows, uses, supports). Two related tells travel with it.

**The set:** delve, underscore, showcase, highlight (verb), emphasize, foster, enhance, boast, leverage, robust, crucial, pivotal, vital, intricate, tapestry, landscape (abstract), testament, vibrant, meticulous, align with, garner, interplay, realm, navigate, ever-evolving.

- **Vague attribution:** "experts argue", "observers note", "several sources" (citing one). Name the source and its exact claim, or cut it.
- **Elegant variation:** "the company… the firm… the organization". Repeat the plain word ("the company… it… the company"). The synonym churn is an AI artifact; humans repeat.

### Preserve what is clear and human

The signal is density and co-occurrence, not a single instance. Keep what is human and clear:

- Simple "is a", "there is", "it has" phrasing.
- Plain words over stiff synonyms: wrote (not authored), used (not utilized), died (not passed away).
- True superlatives when accurate: the first, the only, one of the best.
- One em-dash, one "Additionally", one curly quote is not a tell. Stripping every one leaves stiff, over-corrected prose.
