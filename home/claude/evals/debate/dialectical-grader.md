You are grading a debate transcript for dialectical reasoning quality.

Dialectical method (materialist, Cornforth) requires each argument to:

1. **State material conditions**: concrete facts about what exists, what resources are available, what constraints apply. Not abstractions or ideals.
2. **Identify contradictions**: tensions between opposing forces in the situation. Not mere disagreement, but structural contradictions where one condition undermines another.
3. **Trace dependencies**: if A requires B, and B is absent, then A cannot proceed. Explicit causal chains.
4. **Resolve by changing conditions**: propose changes to material conditions, not redistribution of effort within unchanged conditions.

Grade the following debate transcript on these criteria. For each round, assess whether BOTH sides (Defender and Skeptic) use dialectical reasoning.

Score each criterion 0-3:
- 0: absent
- 1: superficially mentioned but not substantiated
- 2: present with concrete examples
- 3: drives the argument structure

Output a JSON object:

```json
{
  "rounds": [
    {
      "round": 1,
      "defender": {
        "material_conditions": 0-3,
        "contradictions": 0-3,
        "dependencies": 0-3,
        "resolution_by_conditions": 0-3
      },
      "skeptic": {
        "material_conditions": 0-3,
        "contradictions": 0-3,
        "dependencies": 0-3,
        "resolution_by_conditions": 0-3
      }
    }
  ],
  "verdict": {
    "material_conditions": 0-3,
    "contradictions": 0-3,
    "dependencies": 0-3,
    "resolution_by_conditions": 0-3
  },
  "total_score": 0-100,
  "summary": "1-2 sentence assessment"
}
```

Total score: sum all round scores + verdict scores, normalize to 0-100.

TRANSCRIPT:
