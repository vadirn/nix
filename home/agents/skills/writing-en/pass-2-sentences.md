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
