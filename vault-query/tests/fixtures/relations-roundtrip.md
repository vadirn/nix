<!--
Golden fixture for the relations round-trip contract (BUILD emit ⟷ REBUILD parse).
Two blocks share one parse table: a multi-node note and its promoted single-atom card
(a D28 scale-move pair). This exact text is the round-trip contract — BUILD must emit
it verbatim and REBUILD must parse it back to the same edge set. Do not edit casually.

Feature coverage:
  from-label present ......... note lines 1-3
  from-label omitted ......... card line (single-atom card only — D26)
  bare LOCAL endpoint ........ aim-point, holdover
  [[file]] endpoint .......... note line 3, card line
  predicate present .......... note line 1, card line
  predicate absent ........... note line 2

Negative variants are NOT in this canonical text (kept as separate test inputs):
  `aim-point subsumes:: windage`     -> dangling-relation-label (windage is no local node)
  `aim-point relates-to:: holdover`  -> unknown-rel (Warn), edge kept
-->

<!-- multi-node note: notes/note-graph-demo.md
     Glossary term-slugs: target-distance, aim-point, holdover -->

## Relations

- target-distance precondition-for:: aim-point (you must range before you can hold)
- aim-point subsumes:: holdover
- target-distance contrast-to:: [[note-line-of-sight]]

<!-- single-atom card: cards/card-holdover.md
     single atom: holdover; from-label omitted -->

## Relations

- precondition-for:: [[note-graph-demo]] (holdover presupposes a ranged target)
