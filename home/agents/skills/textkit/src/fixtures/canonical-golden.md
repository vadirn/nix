---
type: distillation
source: { path: canonical-grammar.txt, bytes: 812, sha256: a1b2c3d4e5f6 }
schema: 1.0
---

# Canonical projection grammar

## Abstract

The seven-section projection is a fixed wire format: every reader parses these
bytes, so their spacing, anchors, and fences must stay frozen as a golden fixture.

## Concepts

### Wire format

A byte layout a writer and every reader agree on. 10..44

- changing it silently breaks the readers 210..252

### Golden fixture

A checked-in expected output frozen as bytes, regenerated only on purpose. 46..88

## Judgements

- every reader parses the same emitted grammar 300..360
- (necessarily) a format drift must fail a test, never pass silently 362..420
- (hypothesis) a single golden note may cover the whole grammar 422..470

## Inferences

- freezing the bytes pins emit and read at once ⇐ both sides diff the same file 472..540

## Procedures

### Add a golden test

1. emit the graph and write the bytes to a fixture 560..610
2. assert the projector reproduces the fixture 612..650
3. assert every reader parses the fixture 652..700

## Payload

### the one-liner

> freeze the bytes, not the function that made them. 702..752

### sample fence

```
### not a heading
projectMarkdown(graph) === readFileSync(fixture)
```

760..812

## Relations

- golden fixture — pins → wire format  90..160
