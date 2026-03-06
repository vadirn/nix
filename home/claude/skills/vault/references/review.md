# Review

Retrieval practice session over cards in `20 cards/`. Tests recall by showing titles first, then revealing content.

Research basis: retrieval practice is the strongest finding in learning science. Testing produces durable learning; passive re-reading doesn't.

## Process

```
// Phase 1: Select 3 cards
if user provided topic or tag:
  results = Bash(vault-cli search "<topic_or_tag>" -n 10 --files)
  cards = filter results to 20 cards/ only
  pick 3 cards from results
else:
  all = Bash(vault-cli cards)
  seed = pick random card
  similar = Bash(vault-cli search "<seed card title>" -n 5 --files)
  cards = filter to 20 cards/, deduplicate
  pick 3 from seed + similar
// Semantic clustering: similar concepts together tests differentiation

// Phase 2: Sequential recall loop
for each card in 3 selected cards:
  show card title only  // no description, no body
  ask: "What's the core idea? 1-2 sentences."
  wait for response
  read card file, show description + body  // reveal

// Phase 3: Connection synthesis
key_terms = extract from reviewed cards
related = Bash(vault-cli search "<key terms>" -n 10 --files)
if non-trivial pattern, tension, or synthesis across cards:
  propose creating a note in 30 notes/
if user had ideas or reactions during recall:
  propose capturing them as a note in 30 notes/
```

## Notes

- 3 cards per session: enough for useful practice, not tedious
- Cards only, not notes (cards are atomic facts for recall; notes are synthesis)
- Don't ask to edit cards during review. Cards are atomic; edits belong in /vault card
- Follow note process when creating notes from review insights
- Follow obsidian-markdown skill for Obsidian syntax
