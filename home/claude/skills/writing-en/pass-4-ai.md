# Pass 4: AI Patterns

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
  if important aside is parenthesized:
    upgrade to dash  // Match punctuation to emphasis
  if two clauses need a formal link:
    use colon  // Match punctuation to emphasis
  if semicolon joins a long sentence:
    split with a period instead  // Match punctuation to emphasis
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

Avoid em-dashes. They are overused in AI-generated text and become a crutch for loose thinking. Restructure instead.

| Before                                                                | After                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| The system (built in just two weeks) handles 10k requests per second. | The system handles 10k requests per second. It was built in two weeks. |
| The system has one flaw, it cannot recover from crashes.              | The system has one flaw: it cannot recover from crashes.               |
| Three teams, backend, frontend, and SRE, reviewed the design.         | Three teams (backend, frontend, and SRE) reviewed the design.          |
| The response time improved; however the error rate stayed the same.   | The response time improved. The error rate stayed the same.            |

**Alternatives to em-dashes:**

- **Split into two sentences** when the aside carries its own idea
- **Colon** for announcements: "here is what I mean"
- **Parentheses** for minor asides
- **Commas** when the clause is short and unambiguous

**Semicolons** link two closely related sentences when the first is short (under ~15 words). If you need a semicolon because the sentence is long, split it with a period instead.
