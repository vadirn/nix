<!--
Golden fixture for the local-node round-trip (STEP 3a) and dangling-relation-label.
A complete BUILD-shaped distilled note: prose, ## Workflow, ## Glossary, ## Relations.

Local-node slug set (what a bare local endpoint resolves against):
  Glossary terms ... target-distance, aim-point, holdover
  Workflow steps ... range-the-target, hold-over-the-aim-point

The ## Relations block carries one dangling endpoint (`windage` — no local node) so
dangling-relation-label has a positive case; every other bare endpoint resolves and
the `[[file-slug]]` endpoint is out of its scope. Do not edit casually.
-->

---

## type: note

# Shooting holdover

**Target distance** fixes the **aim point**, and **holdover** is the vertical
correction you apply to it before the shot.

## Workflow

1. Range the target
2. Hold over the aim point

## Glossary

| Term            | Definition                          |
| --------------- | ----------------------------------- |
| Target distance | how far the target sits             |
| Aim point       | where the sight rests for a hit     |
| Holdover        | vertical correction for bullet drop |

## Relations

- target-distance precondition-for:: aim-point (range before you hold)
- aim-point subsumes:: holdover
- aim-point subsumes:: windage
- target-distance contrast-to:: [[note-line-of-sight]]
