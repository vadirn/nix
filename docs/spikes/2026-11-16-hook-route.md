# Can one route binary, called once per event, reproduce today's hook decisions without adding noticeable latency?

Date: 2026-11-16
Status: answered for PreToolUse; the other events are untested
Time-box: 3h / 1h 20m

## Method

A throwaway Rust binary, `route`, about 330 lines, uses `serde_json` and `regex` and lived in `_spikes/hook-route/`, deleted on 2026-11-16 along with its data files. It reads one hook event on stdin and picks the handlers today's `settings.json` would run. It follows Claude Code's documented matcher rules: an exact list, an unanchored regex, or match-all. It runs the handlers in parallel with per-handler timeouts and appends one JSONL line per event. With one handler, route hands its answer over untouched. With several, it merges them:

- the strongest decision wins: deny > defer > ask > allow;
- the reasons for that decision are joined;
- `updatedInput` passes through;
- `additionalContext` is joined.

Three checks ran against it:

1. **Replay.** `replay.py` collected every recorded call to a tool with a PreToolUse hook from 1,282 transcripts. That is 75,415 calls, 936 of them denied by a hook. It replayed all 936 denials and up to 150 sampled allowed calls per tool, 1,314 in all, through route. It compared route's answer with the decision Claude Code recorded. The trinket handlers were skipped, because they keep state or call an LLM.
2. **Latency.** hyperfine timed route against a shell baseline that starts the same seven Bash handlers at once.
3. **Live.** For three calls, `settings.json` swapped the seven-handler Bash group for one route entry. The file was restored right after.

Corners cut:

- no fail-open on panic;
- no matcher for non-tool events;
- no `if` field;
- async handlers are spawned but never checked.

## Result

**Decisions.** Route agreed with Claude Code on 969 of the 1,314 replayed calls: 596 denials and 373 passes. Every one of the 345 disagreements traces to a change outside route:

| Count | Cause                                                                                                                                                                              | How it was checked |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 209   | `no-secrets.sh` now fails open. In the hook environment `bash` is `/bin/bash` 3.2, which rejects `${COMMAND,,}`. Every recorded denial dates up to 2026-11-11.                     | Run alone, the script denied 30 of 30 sampled inputs under nix bash 5 and 0 of 30 under `/bin/bash`. |
| 131   | Denials by the trinket handlers, which the replay skipped (`git.message`, turn-check), or by a guard whose input changed since. In 12 of them the recorded `cwd` no longer exists. | The six non-trinket guards, run directly on all 131 payloads, deny none. So route dropped no deny its handlers give today. |
| 5     | Calls from September, before a hook that now denies them existed.                                                                                                                  | Dates and rule texts. |

**Reasons.** On 20 calls, both sides denied but the reason text differs. In each, two guards denied the same call. Claude Code reported one reason, and route reported both. None of the 936 recorded denials carries two reasons. A live control settled it: with the hooks restored, `git -C . log -1 && rg -g '!*.lock' route` trips both `no-dangerous.py` and `rg-glob-guard.sh`. Claude Code showed only `no-dangerous.py`'s reason, from the third handler, which is also the slower one. So Claude Code reports one reason when several hooks deny, and it is not the first to finish. Which one it picks is unknown.

**Latency** (hyperfine, 40 runs, payload `ls -la`):

| Run                                        | Mean |
| ------------------------------------------ | ---- |
| route with no handlers (startup)           | 4.1 ms ± 0.6 |
| route with the 7 Bash handlers, logging on | 39.5 ms ± 0.8 |
| shell baseline: the same 7 started at once | 43.4 ms ± 1.4 |

Inside route, an event took 33.1 ms on average against 32.6 ms for its slowest handler, `no-dangerous.py`. The three Python guards account for most of the time. The shell baseline only models Claude Code's own dispatch. In place, Claude Code timed the route entry at 109, 133 and 44 ms on the three live calls, where route's log says 92, 106 and 41 ms. The transcript does not record the total for today's separate hooks, so there is no in-place baseline.

**Live.** Claude Code acted on route's merged answer:

- `make hi` printed only `hi`, so `quiet-override.sh`'s rewrite to `make -s hi` took effect;
- `git -C . status` was denied with the same text as before;
- a command that tripped two guards showed both reasons, one per line.

**Log.** route's JSONL recorded `no-secrets.sh` writing to stderr on 777 replayed events. A log of every handler's stderr would have exposed the failure above on its first day.

## Decision

Proceed: for PreToolUse, one route binary reproduces today's decisions and adds about 4 ms per event.

## Choices made

- **Throwaway spike over a retained tracer bullet.** The user chose this. The cost: the real crate starts from nothing. What it bought: no commitment to the router before there was evidence for it. The spike code is deleted. The real crate takes from it only this memo's merge rules and replay method.
- **Claude Code's recorded decisions as ground truth, over a model of its dispatch.** A model would have been written from the same reading of the docs as route, so it would share route's blind spots. The cost: recorded decisions also capture changes to scripts and their environment since the call. Every mismatch therefore needs a direct run of each handler to place the blame. The per-hook records in transcripts could not replace this, because Claude Code records only hooks that allowed a call or rewrote its input, never the denying hook's output.

## Next step

Start the retained route crate fresh under the flake, with the event log in place from the start. Its acceptance test is the replay described below, rebuilt alongside the crate. It passes when every mismatch has a cause outside route. Owner: Vadim.

The replay, so it survives the spike's deletion:

- **Ground truth:** a `tool_result` that opens `PreToolUse:<tool> hook error: <reason>` was denied by a hook; any other result ran.
- **Corpus:** every recorded call to Bash, Read, Grep, WebSearch, WebFetch and `mcp__visualize__show_widget` under `~/.claude/projects/**/*.jsonl`.
- **Sample:** every denial, plus up to 150 allowed calls per tool, drawn with `random.seed(7)`.
- **Payload:** `{hook_event_name: "PreToolUse", tool_name, tool_input, cwd}`, with `cwd` taken from the recorded line.
- **Skipped:** every handler whose command contains `trinket` or `turn-check`.
- **Attribution:** for each mismatch, run every non-skipped handler on its own. Route is at fault only when a handler alone denies and route did not.

## Checks

Confidence: 7/10. Biggest risk that could lower this grade: the merge rules for UserPromptSubmit, SessionStart, Stop and PostToolUse never ran against Claude Code.

What would falsify this conclusion: a recorded PreToolUse call that route decides differently even though every handler's script and environment are unchanged. Branches the prototype did not exercise:

- plain stdout as context for UserPromptSubmit and SessionStart;
- the block merge for Stop and PostToolUse;
- async handlers (`sound.sh`);
- timeouts and fail-open;
- trinket's Stop and UserPromptSubmit handoff;
- the env vars direnv needs (`CLAUDE_ENV_FILE`);
- SessionEnd's 1.5 s budget;
- `updatedInput` from two hooks at once.

Reasoning chain:

- Thesis: route can stand in for Claude Code's dispatch on PreToolUse.
- Premise 1: route agrees with Claude Code's recorded decisions wherever script and environment are unchanged. Grounds: the replay table, with the 209 and the 131 confirmed by direct runs.
- Premise 2: Claude Code acts on route's merged answer as it acts on separate answers. Grounds: the three live calls.
- Premise 3: route's added time is small next to its handlers. Grounds: hyperfine against a shell model of the dispatch. There is no in-place baseline.

## Decisions for the real crate

Decided:

- **Event log: JSONL as the record, plus a derived index.** Chosen on 2026-11-16. route appends one JSON line per event to a per-day file. The Rune viewer builds a SQLite or DuckDB index from those files and may drop and rebuild it at any time. Data flows one way, from log to index, so the two cannot disagree. SQLite alone was rejected: every short-lived hook process would open and lock the database, and each new field would need a migration. The cost accepted: two mechanisms instead of one, an index that lags the log until the viewer reads the new lines, and queries outside the viewer that run on raw files through `jq` or DuckDB. Reopen this only if cross-session queries become the log's main use and the index's lag gets in their way. Longevity did not decide it: the Library of Congress lists both line-oriented text and SQLite as preferred dataset formats.
- **One write per line.** The spike wrote each line with `writeln!`, which can split a line across two `write()` calls, so two route processes could interleave. The crate builds the line and its newline in one buffer, holds `flock` on the file, and writes once.
- **Retention.** The log records tool input, which can carry secrets. The crate truncates command text and handler output, and deletes day files past a fixed age.

Recommended, not yet decided:

- **Config: Claude Code's own hooks JSON**, `{"hooks": {...}}`, in a file route reads. It adds no second schema to mirror, the replay already consumed this shape, and pasting the entries back into `settings.json` undoes route. YAML was rejected because `serde_yaml` is unmaintained. TOML would mirror Claude Code's schema and need a translator for every new hook field.
- **Toggles in a separate state file** owned by the Rune app, such as a list of disabled handlers, so the app never rewrites the hand-edited config.

Still open:

- join every deny reason, as the spike does, or report one, as Claude Code does today;
- on a route crash, fail open or fail closed;
- where route lives: this repo or Trinket;
- whether the Rune app only reads, or also writes the state file.
