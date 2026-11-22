```text
   *    .    *      _       .    *
              .    (_)   *
  .      _ __  ___  __         .
   *    | '_ \| \ \/ /    *
        | | | | |>  <       .
   .    |_| |_|_/_/\_\  *
         aarch64-darwin
```

Personal macOS system config. Three areas: a Nix flake that declaratively manages two Macs, a full Claude Code global configuration, and `vault-query`, a query CLI for an Obsidian vault. The markdown core it builds on lives in [md-for-agents](https://github.com/vadirn/md-for-agents) and arrives here as a pinned flake input.

## Machines

`vdrn-studio` and `vdrn-mbp`. Both aarch64-darwin, both managed by the same `flake.nix` on the `nixos-25.11` branch.

## Nix / home-manager

`flake.nix` is the entry point. `home/` holds all home-manager modules: packages, dotfiles, zsh, git (SSH signing, global hooks), tmux, starship, yazi, Ghostty, lazygit, micro, and delta with a Catppuccin Mocha theme.

`rebuild.sh` is the single command that runs `darwin-rebuild switch`, installs Zed/browser plugins, syncs agent symlinks, and installs npm globals.

## Claude Code configuration

`home/claude/` contains `settings.json` with sandbox permissions and environment variables. `home/claude/hooks/` has PreToolUse safety hooks: dangerous command blocking, sensitive file guards, `/commit` and `/pr` nonce enforcement, Firecrawl MCP routing, and sound notifications.

`home/claude/plugins/` holds function-hook plugins, loaded from the main checkout through `CLAUDE_CODE_PLUGIN_DIRS` in `settings.json`. `context-meter` draws the context window fill above the prompt, green under 200k tokens, amber under 350k, red past that, with a button to compact. It runs on Claude Code 2.1.286; 2.1.280 lacks the `$.state` it keeps its values in. `claude plugin test home/claude/plugins/context-meter` runs its tests.

Formatting is agent-driven, not automatic: `home/agents/skills/tools/autoformat/autoformat.ts` (a bun CLI, on PATH as `autoformat`) routes each file to its formatter — the project's `format:file` script, else deno fmt, else mdformat for `.md` and oxfmt for the rest, or ruff, or alejandra, or rustfmt — and `home/claude/hooks/hint-autoformat.sh` names it in the PostToolUse context after every Write and Edit. Nothing rewrites a file behind the agent, so a reflow can never land between two Edits and break the second one.

`agents/AGENTS.md` is the shared reasoning and communication ruleset (dialectical method, formal logic, prose style). `agents/skills/` holds ~30 skills (`commit`, `pr`, `vault`, `debate`, `probe`, `work`, `tdd`, `writing-*`, `variants`, etc.); it is also a bun workspace with pinned TypeScript and oxlint, whose `tools/` member holds the `autoformat` CLI. `agents/agents/` holds subagent definitions. `agents/scripts/sync-agents.sh` re-creates agent symlinks without a full rebuild.

## Rust workspace

`vault-query` is the only crate in the root workspace, rooted at `Cargo.toml`. It links `mdstruct` as a git dependency on [md-for-agents](https://github.com/vadirn/md-for-agents), pinned by rev in `Cargo.lock`. `shell.nix` provides the dev toolchain (`nix-shell`, then `cargo test --workspace`).

`hooky/` is a second crate with its own workspace and `Cargo.lock`, so neither crate's edits rebuild the other. `nix build .#hooky` builds it and runs its tests. `hooky-console/` is a third, for the same reason and because Rune's `[patch.crates-io]` table must sit at a workspace root.

## hooky

The hook router for Claude Code and, with `--harness codex`, for Codex ([Codex](#codex)). `settings.json` gives each hook event one entry, `hooky <Event>`. hooky reads the event JSON on stdin, runs the handlers listed for that event in `home/claude/hooky/hooks.json` (linked to `~/.config/hooky/hooks.json`) in parallel, and gives Claude Code one answer. The hooks file uses Claude Code's own `{"hooks": ...}` shape, so pasting its entries back into `settings.json` undoes hooky.

- **Answer:** when only one handler says anything, hooky passes its stdout, stderr and exit code through unchanged. When several do, hooky merges them. The strongest permission decision wins (deny > defer > ask > allow), every reason for it is kept, one per line, and added context is joined.
- **Failure:** if hooky itself fails (a panic, a bad hooks file, a stuck run), it denies on PreToolUse and lets every other event through. A failing handler stays a non-blocking error, as Claude Code treats it. Whatever ends hooky early, a signal included, kills the handlers still running. Async handlers are detached and keep going.
- **Can't start:** hooky's PreToolUse entry carries `onFailure: "block"`, so a hooky binary that is missing or cannot start also denies the call. Claude Code 2.1.295 and later honour it; older versions ignore it. Under it, any exit but 0 or 2 blocks, so on PreToolUse hooky reports a handler's failure in `systemMessage` with exit 0, logged as mode `rewritten`.
- **Toggles:** `~/.local/state/hooky/state.json` lists switched-off handlers as `{"disabled": [{"event", "matcher", "command"}]}`.
- **Builtins:** `hooky.builtins` in the hooks file maps a handler's command to a guard that hooky runs in-process, `{"python3 ~/.claude/hooks/no-dangerous.py": "no-dangerous"}`. The entry keeps its script command, so its toggle key stays the same, deleting the map line puts the script back, and a binary without that guard runs the script. The six Bash guards (`hooky/src/guards/`) read one shared parse of the command (`hooky/src/shell.rs`), made once per event: quotes removed, `$(...)`, backticks, `bash -c` and `eval` read as commands, and a heredoc body read as data unless a shell reads it. Their cases live in `hooky/tests/guards/*.json` and run inside `nix build .#hooky`. Where the shared parse decides differently from a script, the case records the script's answer and why. `scripts/hooky-guard-fixtures.py` checks those answers against the scripts, and `scripts/hooky-guard-diff.py ./result/bin/hooky` compares each guard with its script over every Bash command in the transcripts.
- **Log:** one JSON line per event in `~/.local/state/hooky/log/YYYY-MM-DD.jsonl`, naming its harness in `"harness"`. Each line is written once under `flock`. Input and handler output are truncated, and day files older than `hooky.log.retention_days` (default 30) are deleted.

`scripts/hooky-dryrun.py ./result/bin/hooky` replays recent real events through hooky and through each handler run alone, and reports where they disagree.

hooky is on PATH, linked at `~/.local/bin/hooky`. `settings.json` calls it by that full path, since a harness may not see the shell's PATH. It used to be called route, a name macOS's own `/sbin/route` kept off PATH. `./rebuild.sh` moves its old state folder, `~/.local/state/route`, to `~/.local/state/hooky` once. A Mac must run `./rebuild.sh`, which links the binary and the hooks file, before it pulls a `settings.json` that calls hooky. Otherwise no hook can start: Claude Code 2.1.295 and later deny every PreToolUse call, and older versions let every tool call through.

Every hook in `settings.json` goes through hooky, and the switch checks it: a `home.checks` entry regenerates the hooky entries from `hooks.json` and fails when `settings.json`'s `hooks` differ, so a hook wired into `settings.json` directly, or a `hooks.json` change not yet applied, stops `./rebuild.sh` before anything deploys. hooky reads `hooks.json` on every event, so a handler change applies on the next one; only a change to hooky's own entries (an event gained or lost, a wider matcher, a longer timeout) must reach `settings.json`. After each `hooks.json` change, run:

```bash
hooky install
```

It prints the events whose entries changed, or that nothing did. It writes through `~/.claude/settings.json`'s link into this repo's file and replaces only the `hooks` value, so the rest of the file keeps its formatting. A hook in `settings.json` that does not call hooky stops it, since the write would drop that hook: move the hook into `hooks.json` first. Without `--bin`, the entries call hooky by the path it ran from, written from `~/`, the form the check expects. From inside the Nix store, as under `nix run`, install stops and asks for `--bin`, since garbage collection would delete the path the entries call.

### Codex

The same binary serves Codex. Codex's settings, `home/codex/hooks.json` (linked to `~/.codex/hooks.json`), give each event one entry, `hooky --harness codex <Event>`. hooky then reads Codex's own handler list, `home/codex/hooky/hooks.json` (linked to `~/.config/hooky/codex/hooks.json`), and its own toggles, `~/.local/state/hooky/codex/state.json`. Both harnesses write the one log; a line without `"harness"` predates the field and is Claude Code's.

- **Can't start:** Codex has no `onFailure`, so its entries leave it out, and a hooky that cannot start lets the call through.
- **Ask and defer:** Codex fails open on both. No handler in Codex's list answers either.
- **Trust:** Codex asks once in `/hooks` to trust each new or changed entry in `~/.codex/hooks.json`. A handler change that leaves the generated entries as they are needs no new trust.
- **Matchers:** the PreToolUse and PostToolUse matchers name `functions.exec_command`, whose dot makes them a regex, so Codex's entries start hooky on every tool call, and the log records each tool name Codex sends.

The wiring check covers Codex's settings too. After each change to Codex's handler list, run:

```bash
hooky --harness codex install
```

## hooky-console

`Hooky Console.app`, a macOS window onto hooky's log and handlers, built on [Rune](https://github.com/anomalyco/rune) (pinned by rev; the bump steps head `hooky-console/Cargo.toml`). It opens on today's events in the order hooky wrote them, as a tail reads, and checks for new lines every half second. The list moves only when you move it, or while you are at its end: there it follows new rows, scrolling up pauses it while rows keep loading below, and scrolling back down follows again. Picking a row pauses it too; a "↓ Latest" pill floats over the list's foot while rows lie below, and it and End jump to the newest. Nothing is picked until you pick: a filter that hides the picked row leaves it in the inspector, marked hidden, and a filter that changes the rows above it keeps it in place on screen, as far as the list's length allows. The sidebar filters by hook event, the toolbar by text, and the inspector shows the picked event's input, reasons, rewrite, stderr and per-handler timings. Its replay button sends a logged Bash call through hooky again and shows each guard's answer now beside the logged one. Only the sidebar moves, sliding open and shut; everything else, colours included, changes at once.

Each harness hooky serves is a space of its own, as in Arc. Two icons at the sidebar's foot, Claude Code's and Codex's marks, switch between them (⌃1, ⌃2). A space keeps its own Log (rows, filter, pick and place), Health, Handlers and switches, and hook events while the other shows. The space's name sits above Log, and its accent colours the selection and the sidebar's icons: blue for Claude Code, teal for Codex. An orange dot marks the other space's icon while its Health has issues. A switch slides the sidebar's contents sideways, the space's own leaving on its side as the other's come in; the rest of the window lands at once.

The Health screen sums up today from the same index. Its issues are handlers that failed (could not start, timed out, or exited with an error), counting the tool calls a failing guard let through, and handlers that wrote to stderr at exit 0, which Claude Code never shows; each opens the Log on exactly the events it counts. Below them are the median time a Bash call waits, per handler and for hooky's run, and hooky's log limits from `hooks.json`, shown, not set. The Log keeps its place, pick and pill while Health shows.

The Handlers screen lists the hooks file's handlers by hook event and matcher, each with its timeout, an async badge and a switch. Each hook event in the sidebar is a page of its own, as each row of Arc's sidebar is a tab, so one row lights at a time: the Log of that event alone, beside the event's handlers and their switches, each showing what it did for the picked row and how long it took. A switch writes `state.json`, which hooky reads on every event, so the next event runs without that handler and logs it under `skipped`. A built-in guard keeps its script command as its key, so one switch serves both. A status bar counts the handlers off and turns them all back on.

- **Replay:** hooky itself, the binary Claude Code runs (`--hooky`, default `~/.local/bin/hooky`), run as the event's harness (`--harness codex` for Codex's; Claude Code's events pass no flag, so a hooky that predates it still replays them), with `--state` and `--log-dir` in a scratch directory, as `scripts/hooky-dryrun.py` runs it. Only the built-in guards run; every other handler is switched off in the scratch state, so nothing with side effects (an LLM call, per-turn state, a verify chain, a sound) runs twice, and a handler added later stays out until it joins `hooky.builtins`. The payload is rebuilt from the logged command and cwd, which is all the guards read, so a call whose command the log cut short cannot be replayed.

- **Reads and writes:** it reads the day files and each harness's hooks file, found as hooky finds them (`XDG_STATE_HOME`, `XDG_CONFIG_HOME`, or `--log-dir`, `--config`, `--state`, which name Claude Code's; Codex's sit in `codex/` beside them). A log line without a `harness` is Claude Code's. It writes only the shown space's `state.json`, read again before each change and replaced whole through a renamed temporary file, so hooky never reads half a file; Enable all clears only that one. It never writes `hooks.json`, which is edited by hand (the toolbar button opens it), and never takes the log's `flock`.
- **Index:** a SQLite cache at `~/Library/Caches/hooky-console/index.sqlite` (`--index`), private (0600) as hooky's log is, since tool input can carry secrets. The JSONL files stay the record: a schema change drops the cache and rebuilds it from the files, and deleting it by hand is always safe.
- **Build:** `nix build .#hooky-console` runs its tests and leaves `result/Applications/Hooky Console.app`, ad hoc signed and loading only system libraries (the build fails otherwise). `scripts/sign-hooky-console.sh` copies it out of the store and signs it with your Developer ID (hardened runtime, timestamped; not notarized), into `~/Applications` unless given another destination. `./rebuild.sh` does both: the switch builds it and links it at `~/.local/share/hooky-console`, then the sign script installs it. The installed copy records the store path it came from (`Contents/Resources/store-path`), so a rebuild that left the app alone skips signing, and a failed signing (no Developer ID on this Mac, or offline) keeps the old copy.
- **Icon:** `hooky-console/icon/AppIcon.icon`, an Icon Composer document of a path climbing a hill, in four layers (sky, ridges, hill, path) that macOS renders as Liquid Glass. Edit it in Icon Composer (Xcode > Open Developer Tool), then run `scripts/hooky-console-icon.sh`: `actool` compiles it into the committed `Assets.car` and `AppIcon.icns`, since the nix sandbox cannot reach Xcode.
- **Headless:** `result/bin/hooky-console --snap out.png --theme dark` renders it without a window; `--scene canvas` swaps in the design canvas's sample events, `--scene health` adds handlers in trouble and opens Health, `--scene handlers` opens Handlers, `--scene spaces` shows the `live` scene's Claude Code list beside the design's Codex events, and `--scene live` a list that grows by one sample event every half second, for `--script` and `--video` runs of scrolling and following. `scripts/check-hooky-console.sh` replays the scripts in `hooky-console/checks` that way and checks Rune's scroll state, which the unit tests cannot reach: a click at the end pauses the list and shows the pill, a click on a row half under an edge scrolls it just into view, a filter holds the picked row where it shows, a trip to Health brings the list back where it was, an issue's events are the rows it counts, a pick and a hover land at once, colours included, the sidebar still slides, the table widening with it, a switch brings up the status bar and Enable all takes it away, each hook event opens its own page from any screen with one sidebar row lit, a switch to Codex's space lists only its rows and events and Claude Code's list comes back where it was, filter included, and a replay of the canvas's newest Bash call lists the guards that ran. The sample scenes toggle in memory and replay against their own hooks file, so a check never switches off a live handler.

## md-for-agents

Built from the flake input as one derivation (`nix build .#md-for-agents`) carrying every binary in the workspace. One derivation rather than one per crate, so comrak compiles once and one `cargoHash` covers the lot. Bump the pin with `nix flake update md-for-agents`. The library `vault-query` links follows a separate pin on the same branch: `cargo update -p mdstruct`.

- `mdstruct` — the shared comrak-backed structural-parsing core. It locates structure (headings, fenced code, tables, blockquotes, lists, links, wikilinks, comment-delimited regions, frontmatter) and emits half-open byte spans, never restringifying, so consumers slice their own original bytes and byte-exact write-back is preserved. A library and a thin JSON CLI (`mdstruct FILES...` → NDJSON, with `check` and `stats`).
- `mdformat` — comrak's parser plus our own printer, a sibling to `mdstruct` rather than built on it, since `mdstruct`'s flat span index is deliberately not printable. Formats markdown to a configurable style. `scripts/corpus.sh` runs its partition and idempotence checks over the vault; `scripts/dryrun.sh` applies one rule to a throwaway copy and leaves a reviewable diff.
- `mdsearch` — rank a folder's markdown files against a query, best match first. BM25 over three fields: the file name, the frontmatter `description:`, and the prose after that block. Terms are stemmed in English and Russian. The walk obeys `.gitignore`, `.ignore`, and `.mdsearchignore`, and skips dot-files unless `--hidden`. The index is built in RAM for the one run, so an edit needs no reindex.

## vault-query

A Rust crate in `vault-query/`. Full-text BM25 search via the shared `mdsearch` index. Commands cover the full vault surface: `search`, `backlinks`, `tags`, `projects`, `tracks`, `log`, `lint`, `context`, `resolve`, and more. Markdown structure (headings, links, wikilinks, frontmatter) comes from the shared `mdstruct` core. Reading is left to the agent's own file reader: `get` resolves an entry name fragment to its absolute path, and `consult` points a match too large to inline at its file and the lines of its best section. Built as a Nix package and installed system-wide.
