---
title: Sort by information dependency
tags: organization, prerequisites, order
---

## Sort by information dependency

Explain prerequisites before the things that depend on them. Readers should encounter every concept after they have the context to understand it.

| Before                                                                                                                                           | After                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| The function calls `validate()` to check inputs. [...paragraphs later...] The `validate()` function checks that all required fields are present. | The `validate()` function checks that all required fields are present. The main function calls `validate()` to check inputs. |
| Install the CLI tool. First, make sure you have Node.js installed.                                                                               | First, install Node.js. Then install the CLI tool.                                                                           |

Source: Williams coherence principle 6, RareSkills rule 12
