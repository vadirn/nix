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
