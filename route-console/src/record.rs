//! One log line as the viewer reads it: route's own fields, plus what the
//! design shows that route does not record as a field of its own. Those are
//! derived here, in one place: the event's verdict, each handler's short name,
//! and each handler's note (its reason, context, rewrite or message).
//!
//! route writes the lines (`route/src/main.rs`, `route/src/log.rs`). Every
//! field is read as optional, so a line from an older or newer route still
//! shows what it carries.

use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Handler {
    pub command: String,
    pub name: String,
    pub matcher: String,
    pub exit: Option<i64>,
    pub ms: Option<u64>,
    /// route's one-word summary of the answer. `None` for an async handler,
    /// which route starts and never hears back from.
    pub outcome: Option<String>,
    pub is_async: bool,
    pub timed_out: bool,
    pub spawn_error: Option<String>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    /// What the handler contributed, as text.
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub ts: String,
    pub ts_ms: i64,
    pub event: String,
    pub tool: Option<String>,
    pub input: Option<String>,
    pub mode: Option<String>,
    pub decision: Option<String>,
    pub exit: Option<i64>,
    pub ms: Option<u64>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub reasons: Vec<String>,
    pub handlers: Vec<Handler>,
}

/// Verdicts, strongest first. A permission decision or block is the answer
/// Claude Code acted on; a rewrite, a stop or added context is what a handler
/// did when nothing decided. `none`, `output` and `error` are not verdicts: an
/// error shows as the stderr badge.
const VERDICTS: [&str; 8] = [
    "deny", "block", "ask", "defer", "rewrite", "allow", "stop", "context",
];

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

fn nonblank(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.trim().is_empty())
}

/// A handler's command cut to the script it runs and that script's arguments:
/// `bash ~/.claude/hooks/sound.sh Stop` reads `sound.sh Stop`. A command with
/// no path in it stays whole.
pub fn short_name(command: &str) -> String {
    let words: Vec<&str> = command.split_whitespace().collect();
    let Some(at) = words.iter().position(|w| w.contains('/')) else {
        return command.trim().to_string();
    };
    let base = words[at].rsplit('/').next().unwrap_or(words[at]);
    std::iter::once(base)
        .chain(words[at + 1..].iter().copied())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The input text worth one line: a command or a path, else the compact JSON.
fn input_text(input: &Value) -> String {
    for key in ["command", "file_path", "url", "query", "pattern"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    input.to_string()
}

fn json_object(stdout: &str) -> Option<Map<String, Value>> {
    let t = stdout.trim();
    if !(t.starts_with('{') && t.ends_with('}')) {
        return None;
    }
    match serde_json::from_str(t) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// The handler's contribution read back from its own output, by Claude Code's
/// rules: exit 2 means stderr is the reason; otherwise stdout is JSON or plain
/// context. Output route truncated past its limit no longer parses, and then
/// the note stays empty.
fn own_note(
    outcome: &str,
    exit: Option<i64>,
    stdout: Option<&str>,
    stderr: Option<&str>,
) -> Option<String> {
    if exit == Some(2) {
        return nonblank(stderr.map(|s| s.trim_end().to_string()));
    }
    let stdout = stdout.unwrap_or("");
    let json = json_object(stdout);
    let hso = json
        .as_ref()
        .and_then(|m| m.get("hookSpecificOutput"))
        .cloned()
        .unwrap_or(Value::Null);
    let top = json.map(Value::Object).unwrap_or(Value::Null);
    let note = match outcome {
        "deny" | "allow" | "ask" | "defer" => {
            str_of(&hso, "permissionDecisionReason").or_else(|| str_of(&top, "reason"))
        }
        "block" => str_of(&top, "reason").or_else(|| str_of(&hso, "reason")),
        "rewrite" => hso.get("updatedInput").map(input_text),
        "context" => match top {
            Value::Null => Some(stdout.trim_end().to_string()),
            _ => str_of(&hso, "additionalContext"),
        },
        "stop" => str_of(&top, "stopReason"),
        "output" | "error" => {
            str_of(&top, "systemMessage").or_else(|| stderr.map(|s| s.trim_end().to_string()))
        }
        _ => None,
    };
    nonblank(note)
}

impl Record {
    pub fn parse(line: &str) -> Option<Record> {
        let v: Value = serde_json::from_str(line).ok()?;
        let ts = str_of(&v, "ts")?;
        let event = str_of(&v, "event")?;
        let ts_ms = chrono::DateTime::parse_from_rfc3339(&ts)
            .map(|t| t.timestamp_millis())
            .unwrap_or(0);
        let handlers: Vec<Handler> = v
            .get("handlers")
            .and_then(Value::as_array)
            .map(|hs| hs.iter().map(Handler::from_json).collect())
            .unwrap_or_default();
        let reasons = v
            .get("reasons")
            .and_then(Value::as_array)
            .map(|rs| {
                rs.iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let mut r = Record {
            ts,
            ts_ms,
            event,
            tool: str_of(&v, "tool"),
            input: str_of(&v, "input"),
            mode: str_of(&v, "mode"),
            decision: str_of(&v, "decision"),
            exit: v.get("exit").and_then(Value::as_i64),
            ms: v.get("ms").and_then(Value::as_u64),
            session_id: str_of(&v, "session_id"),
            cwd: str_of(&v, "cwd"),
            reasons,
            handlers,
        };
        r.attribute_reasons();
        Some(r)
    }

    /// route keeps one reason per handler that gave the winning decision, in
    /// config order, and skips blank ones (`route/src/merge.rs`). When the
    /// counts agree the pairing is exact, and it outlives truncated stdout.
    fn attribute_reasons(&mut self) {
        let Some(decision) = self.decision.clone() else {
            return;
        };
        let deciders: Vec<usize> = (0..self.handlers.len())
            .filter(|&i| self.handlers[i].outcome.as_deref() == Some(decision.as_str()))
            .collect();
        if deciders.len() == self.reasons.len() {
            for (i, why) in deciders.into_iter().zip(&self.reasons) {
                self.handlers[i].note = Some(why.clone());
            }
        }
    }

    /// `HH:MM:SS` as route wrote it, in the writing machine's local time.
    pub fn time(&self) -> &str {
        self.ts.get(11..19).unwrap_or(&self.ts)
    }

    pub fn title(&self) -> &str {
        self.tool.as_deref().unwrap_or(&self.event)
    }

    /// The strongest of the decision and the handlers' outcomes.
    pub fn verdict(&self) -> Option<&'static str> {
        let given = |w: &str| {
            self.decision.as_deref() == Some(w)
                || self
                    .handlers
                    .iter()
                    .any(|h| h.outcome.as_deref() == Some(w))
        };
        VERDICTS.into_iter().find(|w| given(w))
    }

    pub fn has_stderr(&self) -> bool {
        self.handlers
            .iter()
            .any(|h| h.stderr.as_deref().is_some_and(|s| !s.trim().is_empty()))
    }

    /// The replacement input of the first handler that rewrote it.
    pub fn rewrite(&self) -> Option<&str> {
        self.handlers
            .iter()
            .find(|h| h.outcome.as_deref() == Some("rewrite"))
            .and_then(|h| h.note.as_deref())
    }

    /// Text search runs over this, lowercased. A handler's name joins it only
    /// when the handler did something or wrote to stderr: every Bash event runs
    /// the same guards, so their names alone would match every Bash row.
    pub fn haystack(&self) -> String {
        let mut parts: Vec<&str> = vec![&self.event];
        parts.extend(self.tool.as_deref());
        parts.extend(self.input.as_deref());
        parts.extend(self.reasons.iter().map(String::as_str));
        for h in &self.handlers {
            let stderr = h.stderr.as_deref().filter(|e| !e.trim().is_empty());
            if (h.result().is_some() && !h.is_async) || stderr.is_some() {
                parts.push(&h.name);
            }
            parts.extend(stderr);
            parts.extend(h.note.as_deref());
        }
        parts.join("\n").to_lowercase()
    }
}

impl Handler {
    fn from_json(h: &Value) -> Handler {
        let command = str_of(h, "command").unwrap_or_default();
        let outcome = str_of(h, "outcome");
        let exit = h.get("exit").and_then(Value::as_i64);
        let stdout = str_of(h, "stdout");
        let stderr = str_of(h, "stderr");
        let note = outcome
            .as_deref()
            .and_then(|o| own_note(o, exit, stdout.as_deref(), stderr.as_deref()));
        Handler {
            name: short_name(&command),
            matcher: str_of(h, "matcher").unwrap_or_default(),
            exit,
            ms: h.get("ms").and_then(Value::as_u64),
            is_async: h.get("async").and_then(Value::as_bool).unwrap_or(false),
            timed_out: h.get("timed_out").and_then(Value::as_bool).unwrap_or(false),
            spawn_error: str_of(h, "spawn_error"),
            command,
            outcome,
            stdout,
            stderr,
            note,
        }
    }

    /// The badge word: the outcome, `async` for a detached handler, or nothing
    /// when the handler said nothing.
    pub fn result(&self) -> Option<&str> {
        if self.is_async {
            return Some("async");
        }
        self.outcome.as_deref().filter(|o| *o != "none")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DENY: &str = r#"{"v":1,"ts":"2026-11-16T15:02:11.101+05:00","event":"PreToolUse","session_id":"s","cwd":"/x","mode":"passthrough","decision":"deny","exit":0,"ms":61,"handlers":[{"matcher":"Bash","command":"bash ~/.claude/hooks/no-secrets.sh","exit":0,"ms":25,"outcome":"none"},{"matcher":"Bash","command":"python3 ~/.claude/hooks/no-dangerous.py","exit":0,"ms":39,"outcome":"deny","stdout":"{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\": \"Blocked: rebase instead of merge.\"}}"}],"tool":"Bash","input":"git merge --ff-only x","reasons":["Blocked: rebase instead of merge."]}"#;

    #[test]
    fn a_deny_line_reads_its_verdict_reason_and_names() {
        let r = Record::parse(DENY).unwrap();
        assert_eq!(r.time(), "15:02:11");
        assert_eq!(r.title(), "Bash");
        assert_eq!(r.verdict(), Some("deny"));
        assert!(!r.has_stderr());
        assert_eq!(r.handlers[0].name, "no-secrets.sh");
        assert_eq!(r.handlers[0].result(), None);
        assert_eq!(r.handlers[1].name, "no-dangerous.py");
        assert_eq!(
            r.handlers[1].note.as_deref(),
            Some("Blocked: rebase instead of merge.")
        );
        assert!(r.ts_ms > 0);
        let hay = r.haystack();
        assert!(hay.contains("no-dangerous.py") && hay.contains("git merge"));
        assert!(
            !hay.contains("no-secrets"),
            "a guard that said nothing is not searchable"
        );
    }

    #[test]
    fn a_rewrite_reads_its_replacement_from_the_handler_stdout() {
        let line = r#"{"v":1,"ts":"2026-11-16T15:00:00.000+05:00","event":"PreToolUse","mode":"passthrough","decision":null,"exit":0,"ms":40,"handlers":[{"matcher":"Bash","command":"bash ~/.claude/hooks/quiet-override.sh","exit":0,"ms":38,"outcome":"rewrite","stdout":"{\n  \"hookSpecificOutput\": {\n    \"hookEventName\": \"PreToolUse\",\n    \"updatedInput\": {\n      \"command\": \"git commit -q -F m.txt\"\n    }\n  }\n}\n"}],"tool":"Bash","input":"git commit -F m.txt"}"#;
        let r = Record::parse(line).unwrap();
        assert_eq!(r.verdict(), Some("rewrite"));
        assert_eq!(r.rewrite(), Some("git commit -q -F m.txt"));
    }

    #[test]
    fn merged_reasons_pair_with_their_handlers_even_when_stdout_was_cut() {
        let line = r#"{"v":1,"ts":"2026-11-16T15:00:00.000+05:00","event":"PreToolUse","mode":"merged","decision":"deny","exit":0,"ms":40,"handlers":[{"command":"a/one.py","exit":0,"ms":3,"outcome":"deny","stdout":"{\"hookSpecificOutput\": {\"permissionDec…[+90 chars]"},{"command":"a/two.sh","exit":2,"ms":4,"outcome":"deny","stderr":"second\n"}],"reasons":["first","second"]}"#;
        let r = Record::parse(line).unwrap();
        assert_eq!(r.handlers[0].note.as_deref(), Some("first"));
        assert_eq!(r.handlers[1].note.as_deref(), Some("second"));
        assert!(r.has_stderr());
    }

    #[test]
    fn an_async_handler_has_no_outcome_and_reads_async() {
        let line = r#"{"v":1,"ts":"2026-11-16T15:00:00.000+05:00","event":"Stop","mode":"silent","decision":null,"exit":0,"ms":5,"handlers":[{"matcher":"","command":"bash ~/.claude/hooks/sound.sh Stop","async":true}]}"#;
        let r = Record::parse(line).unwrap();
        assert_eq!(r.title(), "Stop");
        assert_eq!(r.verdict(), None);
        assert_eq!(r.handlers[0].name, "sound.sh Stop");
        assert_eq!(r.handlers[0].result(), Some("async"));
        assert_eq!(r.handlers[0].ms, None);
    }

    #[test]
    fn plain_stdout_is_context() {
        let line = r#"{"v":1,"ts":"2026-11-16T15:00:00.000+05:00","event":"PostToolUse","mode":"passthrough","decision":null,"exit":0,"ms":5,"handlers":[{"command":"bash ~/.claude/hooks/hint-autoformat.sh","exit":0,"ms":4,"outcome":"context","stdout":"Hint: run autoformat.\n"}]}"#;
        let r = Record::parse(line).unwrap();
        assert_eq!(r.verdict(), Some("context"));
        assert_eq!(r.handlers[0].note.as_deref(), Some("Hint: run autoformat."));
    }

    #[test]
    fn short_names() {
        assert_eq!(
            short_name("~/.local/bin/trinket-git-message"),
            "trinket-git-message"
        );
        assert_eq!(
            short_name("bash ~/.claude/hooks/sound.sh Stop"),
            "sound.sh Stop"
        );
        assert_eq!(short_name("mkdir -p x"), "mkdir -p x");
    }

    #[test]
    fn junk_is_not_a_record() {
        assert!(Record::parse("not json").is_none());
        assert!(Record::parse(r#"{"event":"Stop"}"#).is_none());
    }
}
