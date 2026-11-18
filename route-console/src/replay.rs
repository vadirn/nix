//! Replay: one logged event through route again, to see what its handlers
//! answer now, after a guard changed or a handler was switched off.
//!
//! The app runs route itself, the binary Claude Code runs, with route's own
//! `--state` and `--log-dir` pointed at a scratch directory, as
//! `scripts/route-dryrun.py` does. route picks the handlers, runs them, merges
//! their answers and logs its line there, so the replay is read with the same
//! parser as the Log, and nothing reaches the real log, Health or `state.json`.
//!
//! Only the built-in guards run (decided 2026-11-17): they read the command
//! and answer, nothing more. Every other handler of the event goes into the
//! scratch `state.json` as switched off, so a handler with side effects
//! (calling an LLM, keeping per-turn state, running a verify chain, playing a
//! sound) never runs twice, and one added later stays out until it joins
//! `route.builtins`. The handlers you switched off stay off.
//!
//! The payload is rebuilt from the log line, which keeps the Bash command
//! (cut past `route.log.max_input_chars`) and the cwd: what the guards read
//! (`route/src/guards/mod.rs`, `Ctx`). So replay covers PreToolUse Bash
//! events whose command the log kept whole (decided 2026-11-17, no change to
//! route's log).

use std::fs;
use std::io::Write;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::hooks::{Hooks, Toggles};
use crate::record::{Handler, Record};
use crate::space::Harness;

/// Longer than six guards ever take, and short enough not to hang the window
/// on a route that never answers.
const DEADLINE: Duration = Duration::from_secs(5);

/// What one press of Replay found, for the event picked at the time.
#[derive(Debug, Clone)]
pub struct Replay {
    pub id: i64,
    /// route's line for the replay, or why there is none.
    pub result: Result<Record, String>,
    /// The built-in guards you had switched off for this event when it ran:
    /// shown as off beside what they said when the event was live.
    pub off: Vec<String>,
}

/// The built-in guards of `event` that `yours` switches off, by command.
pub fn switched_off(hooks: &Hooks, event: &str, yours: &Toggles) -> Vec<String> {
    let mut off: Vec<String> = Vec::new();
    for g in hooks.groups(event) {
        for h in g.handlers.iter().filter(|h| hooks.is_builtin(h)) {
            let id = crate::hooks::HandlerId::new(event, &g.matcher, &h.command);
            if yours.is_off(&id) && !off.contains(&h.command) {
                off.push(h.command.clone());
            }
        }
    }
    off
}

/// One guard in the comparison: what it said when the event was live, and
/// what it says now, or `None` now when you switched it off.
#[derive(Debug)]
pub struct Line<'a> {
    pub command: &'a str,
    pub was: Option<&'a Handler>,
    pub now: Option<&'a Handler>,
}

impl Line<'_> {
    /// Whether the guard's say is unchanged. A guard you switched off is
    /// unchanged only when it had said nothing.
    pub fn alike(&self) -> bool {
        let said = |h: Option<&Handler>| {
            (
                h.and_then(Handler::result).map(String::from),
                h.and_then(|h| h.note.clone()),
            )
        };
        match self.now {
            None => said(self.was).0.is_none(),
            Some(_) => said(self.was) == said(self.now),
        }
    }
}

/// The replay beside the logged line, over the guards replay may run: those
/// that ran now and those you switched off. The handlers it never runs are
/// left out of both verdicts, since they had their say only when live.
#[derive(Debug)]
pub struct Comparison<'a> {
    pub was: Option<&'static str>,
    pub is: Option<&'static str>,
    /// In the logged line's order, then any guard new since.
    pub lines: Vec<Line<'a>>,
    /// Handlers replay does not run, by command.
    pub not_replayed: Vec<&'a str>,
}

impl<'a> Comparison<'a> {
    pub fn of(logged: &'a Record, now: &'a Record, off: &[String]) -> Comparison<'a> {
        let ran: Vec<&Handler> = now.handlers.iter().filter(|h| !h.is_async).collect();
        let now_of = |c: &str| ran.iter().copied().find(|h| h.command == c);
        let mut lines: Vec<Line> = logged
            .handlers
            .iter()
            .filter(|l| !l.is_async)
            .filter_map(|l| match now_of(&l.command) {
                Some(n) => Some(Line {
                    command: &l.command,
                    was: Some(l),
                    now: Some(n),
                }),
                None if off.contains(&l.command) => Some(Line {
                    command: &l.command,
                    was: Some(l),
                    now: None,
                }),
                None => None,
            })
            .collect();
        for h in &ran {
            if !lines.iter().any(|l| l.command == h.command) {
                lines.push(Line {
                    command: &h.command,
                    was: None,
                    now: Some(h),
                });
            }
        }
        let not_replayed = now
            .skipped
            .iter()
            .map(String::as_str)
            .filter(|c| !off.iter().any(|o| o == c))
            .collect();
        Comparison {
            was: Record::verdict_of(lines.iter().filter_map(|l| l.was)),
            is: Record::verdict_of(lines.iter().filter_map(|l| l.now)),
            lines,
            not_replayed,
        }
    }

    pub fn summary(&self) -> &'static str {
        if self.was != self.is {
            "Replay: answer changed"
        } else if self.lines.iter().all(Line::alike) {
            "Replay: same answer"
        } else {
            "Replay: same answer, new reasons"
        }
    }
}

/// Whether route cut this text (`route/src/log.rs`, `truncate`): it ends with
/// `…[+N chars]`.
pub fn truncated(s: &str) -> bool {
    let Some(at) = s.rfind("…[+") else {
        return false;
    };
    let tail = &s[at + "…[+".len()..];
    tail.strip_suffix(" chars]")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The event route saw, rebuilt from its log line, or why it cannot be.
pub fn payload(r: &Record) -> Result<Value, String> {
    if r.event != "PreToolUse" || r.tool.as_deref() != Some("Bash") {
        return Err("Replay covers Bash calls, the ones the built-in guards answer".into());
    }
    let command = r
        .input
        .as_deref()
        .ok_or("The log kept no command for this call")?;
    if truncated(command) {
        return Err("The log cut this command short, so it cannot be replayed".into());
    }
    let mut p = json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
    });
    if let Some(cwd) = &r.cwd {
        p["cwd"] = cwd.as_str().into();
    }
    if let Some(s) = &r.session_id {
        p["session_id"] = s.as_str().into();
    }
    Ok(p)
}

/// The scratch `state.json`: what you switched off, plus every handler of the
/// event that is not a built-in guard.
pub fn scratch_state(hooks: &Hooks, event: &str, yours: &Toggles) -> Toggles {
    let mut t = yours.clone();
    for g in hooks.groups(event) {
        for h in g.handlers.iter().filter(|h| !hooks.is_builtin(h)) {
            t.set(
                &crate::hooks::HandlerId::new(event, &g.matcher, &h.command),
                false,
            );
        }
    }
    t
}

/// A private scratch directory, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Scratch, String> {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("route-console-replay-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Runs route as `harness` on `payload`, with `hooks_text` as its hooks file
/// and `state` as its toggles, and returns the line it logged.
pub fn run(
    route: &Path,
    harness: Harness,
    hooks_text: &str,
    event: &str,
    payload: &Value,
    state: &Toggles,
) -> Result<String, String> {
    let scratch = Scratch::new()?;
    let dir = &scratch.0;
    let config = dir.join("hooks.json");
    let state_path = dir.join("state.json");
    let log_dir = dir.join("log");
    fs::write(&config, hooks_text).map_err(|e| format!("{}: {e}", config.display()))?;
    state.save(&state_path)?;
    let mut child = Command::new(route)
        .arg("--config")
        .arg(&config)
        .arg("--state")
        .arg(&state_path)
        .arg("--log-dir")
        .arg(&log_dir)
        .args(harness.args())
        .arg(event)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", route.display()))?;
    if let Some(mut stdin) = child.stdin.take() {
        // A route that exits before reading closes the pipe; its line, or
        // its absence, says what happened.
        let _ = stdin.write_all(payload.to_string().as_bytes());
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < DEADLINE => {
                std::thread::sleep(Duration::from_millis(2))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "route gave no answer within {}s",
                    DEADLINE.as_secs()
                ));
            }
            Err(e) => return Err(format!("route: {e}")),
        }
    };
    let line = fs::read_dir(&log_dir)
        .ok()
        .and_then(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .find(|p| p.extension().is_some_and(|x| x == "jsonl"))
        })
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| text.lines().last().map(String::from));
    match line {
        Some(l) => Ok(l),
        None => {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = std::io::Read::read_to_string(&mut e, &mut err);
            }
            let err = err.trim();
            Err(if err.is_empty() {
                format!("route logged nothing ({status})")
            } else {
                err.to_string()
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::HandlerId;

    fn record(json: Value) -> Record {
        Record::parse(&json.to_string()).unwrap()
    }

    fn bash(input: &str) -> Record {
        record(
            json!({"v": 1, "ts": "2026-11-17T10:00:00.000+05:00", "event": "PreToolUse",
            "tool": "Bash", "input": input, "cwd": "/w", "session_id": "s", "handlers": []}),
        )
    }

    #[test]
    fn route_s_cut_mark_is_read_exactly() {
        assert!(truncated("abcd…[+6 chars]"));
        assert!(!truncated("abcd"));
        assert!(!truncated("echo '…[+ chars]'"), "no count, no cut");
        assert!(
            !truncated("echo …[+6 chars] done"),
            "the mark ends the text"
        );
    }

    #[test]
    fn a_bash_call_rebuilds_as_the_guards_read_it() {
        let p = payload(&bash("git push --force")).unwrap();
        assert_eq!(
            p,
            json!({"hook_event_name": "PreToolUse", "tool_name": "Bash",
                "tool_input": {"command": "git push --force"}, "cwd": "/w", "session_id": "s"})
        );
    }

    #[test]
    fn what_cannot_be_rebuilt_says_why() {
        let cut = format!("{}…[+12 chars]", "x".repeat(500));
        assert!(payload(&bash(&cut)).unwrap_err().contains("cut"));
        let stop = record(json!({"v": 1, "ts": "2026-11-17T10:00:00.000+05:00",
            "event": "Stop", "handlers": []}));
        assert!(payload(&stop).unwrap_err().contains("Bash"));
        let read = record(json!({"v": 1, "ts": "2026-11-17T10:00:00.000+05:00",
            "event": "PreToolUse", "tool": "Read", "input": "/etc/hosts", "handlers": []}));
        assert!(payload(&read).is_err());
    }

    #[test]
    fn the_scratch_state_runs_only_built_in_guards() {
        let hooks = Hooks::of(Some(&json!({
            "route": {"builtins": {"guard": "g", "chime": "c"}},
            "hooks": {"PreToolUse": [
                {"matcher": "Bash", "hooks": [
                    {"type": "command", "command": "guard"},
                    {"type": "command", "command": "llm"},
                    {"type": "command", "command": "chime", "async": true}
                ]},
                {"matcher": "Read", "hooks": [{"type": "command", "command": "reader"}]}
            ]}
        })));
        let mut yours = Toggles::default();
        let off = HandlerId::new("Stop", "", "verify");
        yours.set(&off, false);
        let t = scratch_state(&hooks, "PreToolUse", &yours);
        assert!(!t.is_off(&HandlerId::new("PreToolUse", "Bash", "guard")));
        assert!(t.is_off(&HandlerId::new("PreToolUse", "Bash", "llm")));
        assert!(
            t.is_off(&HandlerId::new("PreToolUse", "Bash", "chime")),
            "an async handler is a process even when listed"
        );
        assert!(t.is_off(&HandlerId::new("PreToolUse", "Read", "reader")));
        assert!(t.is_off(&off), "yours stay off");
    }

    fn line(handlers: Value, skipped: Value) -> Record {
        record(
            json!({"v": 1, "ts": "2026-11-17T10:00:00.000+05:00", "event": "PreToolUse",
            "tool": "Bash", "input": "x", "handlers": handlers, "skipped": skipped}),
        )
    }

    fn deny(command: &str, why: &str) -> Value {
        let out = json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": "deny", "permissionDecisionReason": why}});
        json!({"matcher": "Bash", "command": command, "exit": 0, "us": 3, "outcome": "deny",
            "stdout": out.to_string()})
    }

    fn quiet(command: &str) -> Value {
        json!({"matcher": "Bash", "command": command, "exit": 0, "us": 2, "outcome": "none"})
    }

    #[test]
    fn an_unchanged_guard_reads_the_same_answer() {
        let logged = line(
            json!([quiet("a"), deny("b", "no"), quiet("llm")]),
            json!([]),
        );
        let now = line(
            json!([quiet("a"), deny("b", "no")]),
            json!([{"event": "PreToolUse", "matcher": "Bash", "command": "llm"}]),
        );
        let c = Comparison::of(&logged, &now, &[]);
        assert_eq!((c.was, c.is), (Some("deny"), Some("deny")));
        assert_eq!(c.summary(), "Replay: same answer");
        assert_eq!(
            c.not_replayed,
            ["llm"],
            "a handler replay skips is not compared"
        );
        assert_eq!(c.lines.len(), 2);
    }

    #[test]
    fn a_denying_guard_switched_off_changes_the_answer() {
        let logged = line(json!([quiet("a"), deny("b", "no")]), json!([]));
        let now = line(
            json!([quiet("a")]),
            json!([{"event": "PreToolUse", "matcher": "Bash", "command": "b"}]),
        );
        let c = Comparison::of(&logged, &now, &["b".to_string()]);
        assert_eq!((c.was, c.is), (Some("deny"), None));
        assert_eq!(c.summary(), "Replay: answer changed");
        let off = c.lines.iter().find(|l| l.command == "b").unwrap();
        assert!(
            off.now.is_none() && !off.alike(),
            "shown as off, and changed"
        );
        assert!(
            c.not_replayed.is_empty(),
            "switched off is not 'not replayed'"
        );
    }

    #[test]
    fn a_new_reason_or_a_new_silent_guard_reads_as_such() {
        let logged = line(json!([deny("b", "old words")]), json!([]));
        let now = line(json!([deny("b", "new words"), quiet("c")]), json!([]));
        let c = Comparison::of(&logged, &now, &[]);
        assert_eq!(c.summary(), "Replay: same answer, new reasons");
        let new = c.lines.iter().find(|l| l.command == "c").unwrap();
        assert!(
            new.was.is_none() && new.alike(),
            "a guard new and silent changes nothing"
        );
        let logged = line(json!([quiet("a")]), json!([]));
        let now = line(json!([quiet("a"), quiet("c")]), json!([]));
        assert_eq!(
            Comparison::of(&logged, &now, &[]).summary(),
            "Replay: same answer"
        );
    }

    #[test]
    fn switched_off_names_only_built_in_guards_of_the_event() {
        let hooks = Hooks::of(Some(&json!({
            "route": {"builtins": {"guard": "g"}},
            "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
                {"type": "command", "command": "guard"},
                {"type": "command", "command": "llm"}
            ]}]}
        })));
        let mut yours = Toggles::default();
        yours.set(&HandlerId::new("PreToolUse", "Bash", "guard"), false);
        yours.set(&HandlerId::new("PreToolUse", "Bash", "llm"), false);
        assert_eq!(switched_off(&hooks, "PreToolUse", &yours), ["guard"]);
        assert!(switched_off(&hooks, "Stop", &yours).is_empty());
    }

    #[test]
    fn a_missing_route_is_an_error_not_a_hang() {
        let err = run(
            Path::new("/nonexistent/route"),
            Harness::Claude,
            "{}",
            "PreToolUse",
            &json!({}),
            &Toggles::default(),
        )
        .unwrap_err();
        assert!(err.contains("/nonexistent/route"), "{err}");
    }

    /// A stand-in route that logs the arguments it was given as its input.
    fn echo_route(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("route");
        let script = r#"#!/bin/sh
args="$*"
while [ $# -gt 0 ]; do
  [ "$1" = --log-dir ] && dir="$2"
  shift
done
mkdir -p "$dir"
printf '{"v":1,"ts":"2026-11-17T10:00:00.000+05:00","event":"PreToolUse","input":"%s"}\n' "$args" > "$dir/2026-11-17.jsonl"
"#;
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[test]
    fn route_runs_as_the_event_s_harness_and_claude_s_needs_no_flag() {
        let dir = std::env::temp_dir().join(format!("route-console-echo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let route = echo_route(&dir);
        let args = |h| {
            let line = run(
                &route,
                h,
                "{}",
                "PreToolUse",
                &json!({}),
                &Toggles::default(),
            )
            .unwrap();
            Record::parse(&line).unwrap().input.unwrap()
        };
        let codex = args(Harness::Codex);
        assert!(codex.ends_with("--harness codex PreToolUse"), "{codex}");
        let claude = args(Harness::Claude);
        assert!(
            !claude.contains("--harness") && claude.ends_with(" PreToolUse"),
            "a route without the flag still replays Claude Code's events: {claude}"
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
