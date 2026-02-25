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
          show both variants to user → stop
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

**Cohesion:** end one sentence with info that begins the next. This creates flow between sentences.

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
- **Dash or semicolon** (last resort) — only when the above techniques don't fit. No two dashes within 3 sentences.

Source: Williams principle 5 (cohesion)
