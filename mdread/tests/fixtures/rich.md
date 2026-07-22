---
title: Rich Document
type: note
tags:
  - alpha
  - beta
---

Lede prose before any heading, carrying an inline [the text](https://a.example) and an autolink <https://b.example>.

The lede also names [[Some Note]] and [[Other Note|an alias]].

# Overview

Overview prose, one line.

## Background

Background prose with a reference-style link: [the label][ref]. It runs long enough that a small `--threshold` folds it while `--full` inlines it anyway. Filler sentence one. Filler sentence two. Filler sentence three. Filler sentence four. Filler sentence five. Filler sentence six. Filler sentence seven. Filler sentence eight. Filler sentence nine. Filler sentence ten.

### Deep Detail

Deep prose. The two links in the fence below point nowhere the reader counts:

```text
[not a link](https://never.example)
[[Not A Note]]
```

## Method

Method prose with an image, which is not an outgoing link: ![a picture](assets/pic.png)

# Results

Results prose.

[ref]: https://ref.example
