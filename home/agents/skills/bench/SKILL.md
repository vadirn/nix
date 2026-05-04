---
name: bench
description: >
  Measure elapsed time for a unit of work. Use when benchmarking skill execution.
  Not user-invocable. Used internally by benchmark pipelines.
---

# Bench

Measure wall-clock time for a unit of work using Bash.

```
// Before the work
start_var = Bash(date +%s.%N)

do("the work to measure")

// After the work
elapsed = Bash(echo "$(date +%s.%N) - {start_var}" | bc)

// Save timing
Write("{output_path}.meta.json", {"elapsed_seconds": elapsed})
```

## Reference

### Timing pattern

Use `date +%s.%N` for sub-second precision. Compute elapsed with `bc`.

```bash
START=$(date +%s.%N)
# ... work happens here ...
ELAPSED=$(echo "$(date +%s.%N) - $START" | bc)
```

### Meta file format

```json
{ "elapsed_seconds": 12.3 }
```

Save alongside the output file with `.meta.json` extension.
