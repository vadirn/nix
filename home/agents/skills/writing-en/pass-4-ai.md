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
