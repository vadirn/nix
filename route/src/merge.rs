//! Turning the handlers' answers into the one answer Claude Code gets.
//!
//! When at most one handler said anything, route hands its stdout, stderr and
//! exit code over unchanged, so every special case Claude Code applies to a
//! lone hook still applies. Only when two or more spoke does route read each
//! answer the way Claude Code would and write one merged response:
//!
//! - the strongest permission decision wins: deny > defer > ask > allow;
//! - the reasons of every handler that gave the winning decision are joined,
//!   one per line (decided 2026-11-16: join every deny reason);
//! - blocks on other events join their reasons the same way;
//! - `updatedInput` passes through unless the call is denied;
//! - `additionalContext`, plain-stdout context, `systemMessage` and
//!   `stopReason` are joined.
//!
//! One exception to passing a lone answer on: on PreToolUse, whose entry
//! carries `onFailure: "block"`, a lone handler's failure is rewritten into a
//! `systemMessage` notice at exit 0, since any other exit would block.

use serde_json::{Map, Value};

use crate::event::{self, Block};
use crate::run::Outcome;

/// One handler's result, labelled for messages and the log.
pub struct Answer<'a> {
    pub label: &'a str,
    pub timeout: f64,
    pub outcome: &'a Outcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Perm {
    Allow,
    Ask,
    Defer,
    Deny,
}

impl Perm {
    fn parse(s: &str) -> Option<Perm> {
        match s {
            "allow" => Some(Perm::Allow),
            "ask" => Some(Perm::Ask),
            "defer" => Some(Perm::Defer),
            "deny" => Some(Perm::Deny),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Perm::Allow => "allow",
            Perm::Ask => "ask",
            Perm::Defer => "defer",
            Perm::Deny => "deny",
        }
    }
}

/// How Claude Code reads a hook's stdout.
#[derive(Debug, PartialEq)]
pub enum Stdout {
    Empty,
    Plain(String),
    Json(Map<String, Value>),
    /// Starts with `{` and ends with `}` but is not a JSON object.
    Invalid(String),
}

pub fn classify(stdout: &str) -> Stdout {
    let t = stdout.trim();
    if t.is_empty() {
        return Stdout::Empty;
    }
    if !(t.starts_with('{') && t.ends_with('}')) {
        return Stdout::Plain(stdout.to_string());
    }
    match serde_json::from_str::<Value>(t) {
        Ok(Value::Object(m)) => Stdout::Json(m),
        Ok(_) => Stdout::Invalid("not a JSON object".into()),
        Err(e) => Stdout::Invalid(e.to_string()),
    }
}

/// What one handler's answer means to Claude Code.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Effect {
    pub permission: Option<(Perm, String)>,
    /// A block on an event other than PreToolUse, with its reason.
    pub block: Option<String>,
    pub updated_input: Option<Value>,
    pub context: Vec<String>,
    pub system_message: Option<String>,
    /// `continue: false`, with its `stopReason`.
    pub stop: Option<String>,
    /// A non-blocking error, or exit 2 on an event where it only shows stderr.
    pub notice: Option<String>,
    pub hso_extra: Map<String, Value>,
    pub top_extra: Map<String, Value>,
}

impl Effect {
    /// One word for the log: what this handler contributed.
    pub fn summary(&self) -> &'static str {
        if let Some((p, _)) = &self.permission {
            return p.as_str();
        }
        if self.block.is_some() {
            "block"
        } else if self.stop.is_some() {
            "stop"
        } else if self.updated_input.is_some() {
            "rewrite"
        } else if !self.context.is_empty() {
            "context"
        } else if self.notice.is_some() {
            "error"
        } else if self.system_message.is_some()
            || !self.hso_extra.is_empty()
            || !self.top_extra.is_empty()
        {
            "output"
        } else {
            "none"
        }
    }

    pub fn context_chars(&self) -> usize {
        self.context.iter().map(|c| c.chars().count()).sum()
    }
}

fn first_line(s: &str) -> &str {
    s.trim().lines().next().unwrap_or("")
}

/// Reads one handler's result by Claude Code's exit-code table.
pub fn normalize(event: &str, a: &Answer) -> Effect {
    let o = a.outcome;
    let mut e = Effect::default();
    if let Some(err) = &o.spawn_error {
        e.notice = Some(format!("failed to start: {err}"));
        return e;
    }
    if o.timed_out {
        e.notice = Some(format!("timed out after {}s", a.timeout));
        return e;
    }
    let stderr = o.stderr_text();
    let parsed = classify(&o.stdout_text());
    match o.exit {
        Some(2) => {
            if let Stdout::Json(m) = &parsed {
                apply_json(event, m, &mut e);
            }
            // A blocking decision in the JSON lends its reason; otherwise the
            // reason is stderr. Exit 2 blocks whatever the JSON decided.
            let json_reason = match (&e.permission, &e.block) {
                (Some((Perm::Deny, r)), _) => Some(r.clone()),
                (_, Some(r)) => Some(r.clone()),
                _ => None,
            };
            let reason = json_reason.unwrap_or_else(|| stderr.trim_end().to_string());
            match event::block(event) {
                Block::Permission => e.permission = Some((Perm::Deny, reason)),
                Block::Decision | Block::ExitCode => e.block = Some(reason),
                Block::Notice => e.notice = Some(first_line(&stderr).to_string()),
                Block::Ignored => {}
            }
        }
        Some(0) => match parsed {
            Stdout::Json(m) => apply_json(event, &m, &mut e),
            Stdout::Plain(text) if event::stdout_is_context(event) => e.context.push(text),
            Stdout::Plain(_) | Stdout::Empty => {}
            Stdout::Invalid(err) => e.notice = Some(format!("invalid JSON output: {err}")),
        },
        code => match parsed {
            // Valid JSON decides on its own; the exit code is ignored.
            Stdout::Json(m) => apply_json(event, &m, &mut e),
            Stdout::Invalid(err) => e.notice = Some(format!("invalid JSON output: {err}")),
            Stdout::Plain(_) | Stdout::Empty => {
                let detail = match (code, o.signal) {
                    (_, Some(sig)) => format!("killed by signal {sig}"),
                    (Some(c), None) => format!("exit {c}"),
                    (None, None) => "no exit status".into(),
                };
                let line = first_line(&stderr);
                e.notice = Some(if line.is_empty() {
                    format!("Failed with non-blocking status code ({detail})")
                } else {
                    format!("Failed with non-blocking status code: {line}")
                });
            }
        },
    }
    e
}

fn apply_json(event: &str, m: &Map<String, Value>, e: &mut Effect) {
    let kind = event::block(event);
    let reason = m
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    for (key, value) in m {
        match key.as_str() {
            "continue" => {
                if value == &Value::Bool(false) {
                    let why = m.get("stopReason").and_then(Value::as_str).unwrap_or("");
                    e.stop = Some(why.to_string());
                }
            }
            "stopReason" | "reason" => {}
            "systemMessage" => e.system_message = value.as_str().map(String::from),
            "decision" => match (value.as_str(), kind) {
                // `approve` and `block` are PreToolUse's deprecated spellings
                // of allow and deny.
                (Some("block"), Block::Permission) => raise(e, Perm::Deny, &reason),
                (Some("approve"), Block::Permission) => raise(e, Perm::Allow, &reason),
                (Some("block"), _) => e.block = Some(reason.clone()),
                _ => {
                    e.top_extra.insert(key.clone(), value.clone());
                }
            },
            "hookSpecificOutput" => {
                let Some(hso) = value.as_object() else {
                    continue;
                };
                let why = hso
                    .get("permissionDecisionReason")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                for (k, v) in hso {
                    match k.as_str() {
                        "hookEventName" | "permissionDecisionReason" => {}
                        "permissionDecision" if kind == Block::Permission => {
                            match v.as_str().and_then(Perm::parse) {
                                Some(p) => raise(e, p, why),
                                None => {
                                    e.hso_extra.insert(k.clone(), v.clone());
                                }
                            }
                        }
                        "updatedInput" => e.updated_input = Some(v.clone()),
                        "additionalContext" => {
                            if let Some(s) = v.as_str() {
                                e.context.push(s.to_string());
                            }
                        }
                        _ => {
                            e.hso_extra.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
            _ => {
                e.top_extra.insert(key.clone(), value.clone());
            }
        }
    }
}

/// Keeps the stronger of two decisions one handler gave.
fn raise(e: &mut Effect, p: Perm, reason: &str) {
    if e.permission.as_ref().is_none_or(|(old, _)| p > *old) {
        e.permission = Some((p, reason.to_string()));
    }
}

/// The answer route gives Claude Code, plus what the log records about it.
#[derive(Debug, Default, PartialEq)]
pub struct Response {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: i32,
    pub mode: &'static str,
    /// `deny`, `ask`, `allow`, `defer`, `block`, or none.
    pub decision: Option<String>,
    pub reasons: Vec<String>,
    pub context_chars: usize,
    pub notes: Vec<String>,
}

/// A handler that exited 0 with nothing on stdout said nothing; Claude Code
/// never shows the stderr of a hook that exits 0.
fn silent(o: &Outcome) -> bool {
    o.spawn_error.is_none() && !o.timed_out && o.exit == Some(0) && o.stdout.trim_ascii().is_empty()
}

pub fn respond(event: &str, answers: &[Answer]) -> Response {
    let effects: Vec<Effect> = answers.iter().map(|a| normalize(event, a)).collect();
    let speaking: Vec<usize> = (0..answers.len())
        .filter(|&i| !silent(answers[i].outcome))
        .collect();
    match speaking.as_slice() {
        [] => Response {
            mode: "silent",
            ..Response::default()
        },
        // Where route's entry carries onFailure: block, Claude Code blocks on
        // any exit but 0 and 2 and on unparseable JSON, so a lone handler's
        // failure is rewritten into a non-blocking notice instead of passed on.
        [i] if event::fails_closed(event) && fails(answers[*i].outcome, &effects[*i]) => Response {
            mode: "rewritten",
            ..merge(event, &[(answers[*i].label, &effects[*i])])
        },
        [i] => passthrough(answers[*i].label, answers[*i].outcome, &effects[*i]),
        _ => merge(
            event,
            &speaking
                .iter()
                .map(|&i| (answers[i].label, &effects[i]))
                .collect::<Vec<_>>(),
        ),
    }
}

/// What `onFailure: "block"` would count as a failure of this answer.
fn fails(o: &Outcome, e: &Effect) -> bool {
    e.notice.is_some() || !matches!(o.exit, Some(0) | Some(2))
}

fn passthrough(label: &str, o: &Outcome, e: &Effect) -> Response {
    let mut r = Response {
        mode: "passthrough",
        decision: decision_of(e),
        reasons: reasons_of(e),
        context_chars: e.context_chars(),
        ..Response::default()
    };
    match (o.exit, &e.notice) {
        (Some(code), _) => {
            r.stdout = o.stdout.clone();
            r.stderr = o.stderr.clone();
            r.exit = code;
        }
        // Never started, timed out, or killed: Claude Code would show a hook
        // error notice and let the action through.
        (None, notice) => {
            let notice = notice.as_deref().unwrap_or("no exit status");
            r.stderr = format!("route: {label}: {notice}\n").into_bytes();
            r.exit = 1;
        }
    }
    r
}

fn decision_of(e: &Effect) -> Option<String> {
    match (&e.permission, &e.block) {
        (Some((p, _)), _) => Some(p.as_str().to_string()),
        (None, Some(_)) => Some("block".to_string()),
        _ => None,
    }
}

fn reasons_of(e: &Effect) -> Vec<String> {
    match (&e.permission, &e.block) {
        (Some((_, r)), _) | (None, Some(r)) if !r.is_empty() => vec![r.clone()],
        _ => Vec::new(),
    }
}

/// Joins the non-blank parts. Each part loses its trailing whitespace first:
/// plain stdout ends in a newline, which would otherwise widen the separator.
fn join(parts: &[String], sep: &str) -> Option<String> {
    let kept: Vec<&str> = parts
        .iter()
        .map(|s| s.trim_end())
        .filter(|s| !s.is_empty())
        .collect();
    (!kept.is_empty()).then(|| kept.join(sep))
}

fn merge(event: &str, effects: &[(&str, &Effect)]) -> Response {
    let kind = event::block(event);
    let mut r = Response {
        mode: "merged",
        ..Response::default()
    };
    let mut top = Map::new();
    let mut hso = Map::new();

    // Permission: the strongest decision, with every reason given for it.
    let best = effects
        .iter()
        .filter_map(|(_, e)| e.permission.as_ref().map(|(p, _)| *p))
        .max();
    if let Some(best) = best {
        r.reasons = effects
            .iter()
            .filter_map(|(_, e)| e.permission.as_ref())
            .filter(|(p, why)| *p == best && !why.trim().is_empty())
            .map(|(_, why)| why.clone())
            .collect();
        hso.insert("permissionDecision".into(), best.as_str().into());
        if let Some(why) = join(&r.reasons, "\n") {
            hso.insert("permissionDecisionReason".into(), why.into());
        }
        r.decision = Some(best.as_str().to_string());
    }

    // Blocks on other events.
    let blocks: Vec<String> = effects
        .iter()
        .filter_map(|(_, e)| e.block.clone())
        .collect();
    if !blocks.is_empty() {
        let why = join(&blocks, "\n").unwrap_or_default();
        r.reasons = blocks
            .into_iter()
            .filter(|b| !b.trim().is_empty())
            .collect();
        r.decision = Some("block".to_string());
        match kind {
            Block::ExitCode => {
                r.exit = 2;
                r.stderr = format!("{why}\n").into_bytes();
            }
            _ => {
                top.insert("decision".into(), "block".into());
                top.insert("reason".into(), why.into());
            }
        }
    }

    // A rewrite is moot once the call is denied. Each handler saw the original
    // input and returns a whole replacement, so two rewrites cannot compose:
    // the first in config order wins and the log records the conflict.
    let rewrites: Vec<(&str, &Value)> = effects
        .iter()
        .filter_map(|(l, e)| e.updated_input.as_ref().map(|v| (*l, v)))
        .collect();
    if best != Some(Perm::Deny)
        && let Some((_, first)) = rewrites.first()
    {
        hso.insert("updatedInput".into(), (*first).clone());
        if rewrites.iter().any(|(_, v)| v != first) {
            let who: Vec<&str> = rewrites.iter().map(|(l, _)| *l).collect();
            r.notes.push(format!(
                "conflicting updatedInput from {}; kept the first",
                who.join(", ")
            ));
        }
    }

    let contexts: Vec<String> = effects
        .iter()
        .flat_map(|(_, e)| e.context.clone())
        .collect();
    if let Some(ctx) = join(&contexts, "\n\n") {
        r.context_chars = ctx.chars().count();
        hso.insert("additionalContext".into(), ctx.into());
    }

    let stops: Vec<&Effect> = effects
        .iter()
        .map(|(_, e)| *e)
        .filter(|e| e.stop.is_some())
        .collect();
    if !stops.is_empty() {
        top.insert("continue".into(), false.into());
        let why: Vec<String> = stops.iter().filter_map(|e| e.stop.clone()).collect();
        if let Some(why) = join(&why, "\n") {
            top.insert("stopReason".into(), why.into());
        }
    }

    for (_, e) in effects {
        for (k, v) in &e.hso_extra {
            hso.entry(k.clone()).or_insert_with(|| v.clone());
        }
        for (k, v) in &e.top_extra {
            top.entry(k.clone()).or_insert_with(|| v.clone());
        }
    }
    if !hso.is_empty() {
        let mut named = Map::new();
        named.insert("hookEventName".into(), event.into());
        named.extend(hso);
        top.insert("hookSpecificOutput".into(), Value::Object(named));
    }

    // Separate hooks would each show their failure as a hook error notice.
    // Alone, the notices become route's own non-blocking error; next to other
    // output, they ride in systemMessage, the warning Claude Code shows the user.
    // Where an exit 1 would block (onFailure), they always ride in systemMessage.
    let mut messages: Vec<String> = effects
        .iter()
        .filter_map(|(_, e)| e.system_message.clone())
        .collect();
    let notices: Vec<String> = effects
        .iter()
        .filter_map(|(l, e)| e.notice.as_ref().map(|n| format!("{l}: {n}")))
        .collect();
    if top.is_empty() && r.exit != 2 && messages.is_empty() && !event::fails_closed(event) {
        if !notices.is_empty() {
            r.exit = 1;
            r.stderr = format!("route: {}\n", notices.join("; ")).into_bytes();
        }
        return r;
    }
    messages.extend(notices.into_iter().map(|n| format!("route: {n}")));
    if let Some(msg) = join(&messages, "\n") {
        top.insert("systemMessage".into(), msg.into());
    }
    if !top.is_empty() {
        r.stdout = format!("{}\n", Value::Object(top)).into_bytes();
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn out(exit: i32, stdout: &str, stderr: &str) -> Outcome {
        Outcome {
            exit: Some(exit),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
            ..Outcome::default()
        }
    }

    fn deny(reason: &str) -> Outcome {
        out(
            0,
            &json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                "permissionDecision": "deny", "permissionDecisionReason": reason}})
            .to_string(),
            "",
        )
    }

    fn answers(outcomes: &[Outcome]) -> Vec<Answer<'_>> {
        outcomes
            .iter()
            .enumerate()
            .map(|(i, o)| Answer {
                label: ["a", "b", "c", "d"][i],
                timeout: 5.0,
                outcome: o,
            })
            .collect()
    }

    fn json_of(r: &Response) -> Value {
        serde_json::from_slice(&r.stdout).unwrap()
    }

    #[test]
    fn nothing_said_is_nothing_returned() {
        let outs = [out(0, "", "noise on stderr"), out(0, "  \n", "")];
        let r = respond("PreToolUse", &answers(&outs));
        assert_eq!(
            (r.exit, r.stdout.len(), r.stderr.len(), r.mode),
            (0, 0, 0, "silent")
        );
    }

    #[test]
    fn a_lone_answer_passes_through_byte_for_byte() {
        let outs = [
            out(0, "", ""),
            out(2, "raw stdout", "blocked: reason\n"),
            out(0, "", ""),
        ];
        let r = respond("PreToolUse", &answers(&outs));
        assert_eq!(r.mode, "passthrough");
        assert_eq!(r.exit, 2);
        assert_eq!(r.stdout, b"raw stdout");
        assert_eq!(r.stderr, b"blocked: reason\n");
        assert_eq!(r.decision.as_deref(), Some("deny"));
    }

    #[test]
    fn a_lone_timeout_becomes_a_non_blocking_error() {
        let timed_out = Outcome {
            timed_out: true,
            stdout: b"partial".to_vec(),
            ..Outcome::default()
        };
        let r = respond("Stop", &answers(&[timed_out]));
        assert_eq!(r.exit, 1);
        assert!(r.stdout.is_empty());
        assert_eq!(
            String::from_utf8_lossy(&r.stderr),
            "route: a: timed out after 5s\n"
        );
    }

    #[test]
    fn on_pre_tool_use_a_lone_failure_becomes_a_notice_not_an_exit_1() {
        // route's PreToolUse entry carries onFailure: block, under which any
        // exit but 0 and 2, or unparseable JSON, would block the call.
        let timed_out = Outcome {
            timed_out: true,
            ..Outcome::default()
        };
        for (o, notice) in [
            (timed_out, "route: a: timed out after 5s"),
            (
                out(1, "", "boom\nmore"),
                "route: a: Failed with non-blocking status code: boom",
            ),
            (
                out(127, "", ""),
                "route: a: Failed with non-blocking status code (exit 127)",
            ),
            (out(0, "{not json}", ""), "route: a: invalid JSON output:"),
        ] {
            let r = respond("PreToolUse", &answers(&[o]));
            assert_eq!(
                (r.exit, r.mode, r.decision.as_deref()),
                (0, "rewritten", None)
            );
            assert!(r.stderr.is_empty());
            let msg = json_of(&r)["systemMessage"].as_str().unwrap().to_string();
            assert!(msg.starts_with(notice), "{msg}");
        }

        // Valid JSON still decides under a non-zero exit, now at exit 0.
        let mut d = deny("json wins");
        d.exit = Some(1);
        let r = respond("PreToolUse", &answers(&[d]));
        assert_eq!(r.exit, 0);
        assert_eq!(
            json_of(&r)["hookSpecificOutput"]["permissionDecision"],
            "deny"
        );

        // Several failures and nothing else: one notice each, still exit 0.
        let outs = [out(1, "", "boom"), out(3, "", "bang")];
        let r = respond("PreToolUse", &answers(&outs));
        assert_eq!(r.exit, 0);
        assert_eq!(
            json_of(&r)["systemMessage"],
            "route: a: Failed with non-blocking status code: boom\nroute: b: Failed with non-blocking status code: bang"
        );
    }

    #[test]
    fn deny_wins_and_every_deny_reason_is_kept() {
        let allow = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "piped"}}"#,
            "",
        );
        let ask = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask"}}"#,
            "",
        );
        let outs = [allow, deny("first"), ask, deny("second")];
        let r = respond("PreToolUse", &answers(&outs));
        assert_eq!(r.mode, "merged");
        assert_eq!(r.exit, 0);
        assert_eq!(
            json_of(&r),
            json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                "permissionDecision": "deny", "permissionDecisionReason": "first\nsecond"}})
        );
        assert_eq!(r.reasons, ["first", "second"]);
    }

    #[test]
    fn exit_two_denies_with_stderr_and_joins_json_denials() {
        let outs = [out(2, "", "by exit code\n"), deny("by json")];
        let r = respond("PreToolUse", &answers(&outs));
        assert_eq!(
            json_of(&r)["hookSpecificOutput"]["permissionDecisionReason"],
            "by exit code\nby json"
        );
    }

    #[test]
    fn exit_two_cannot_be_overridden_by_its_own_allow() {
        let allow_then_2 = out(
            2,
            r#"{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}"#,
            "no\n",
        );
        let e = normalize("PreToolUse", &answers(&[allow_then_2])[0]);
        assert_eq!(e.permission, Some((Perm::Deny, "no".into())));
    }

    #[test]
    fn a_rewrite_passes_through_beside_an_allow() {
        let rewrite = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"command": "make -s hi"}}}"#,
            "",
        );
        let allow = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}"#,
            "",
        );
        let r = respond("PreToolUse", &answers(&[rewrite, allow]));
        assert_eq!(
            json_of(&r),
            json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                "permissionDecision": "allow", "updatedInput": {"command": "make -s hi"}}})
        );
    }

    #[test]
    fn a_deny_drops_the_rewrite() {
        let rewrite = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"command": "x"}}}"#,
            "",
        );
        let r = respond("PreToolUse", &answers(&[rewrite, deny("no")]));
        assert!(
            json_of(&r)["hookSpecificOutput"]
                .get("updatedInput")
                .is_none()
        );
    }

    #[test]
    fn two_different_rewrites_keep_the_first_and_note_it() {
        let rw = |c: &str| {
            out(
                0,
                &json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"command": c}}}).to_string(),
                "",
            )
        };
        let r = respond("PreToolUse", &answers(&[rw("one"), rw("two")]));
        assert_eq!(
            json_of(&r)["hookSpecificOutput"]["updatedInput"]["command"],
            "one"
        );
        assert_eq!(r.notes.len(), 1);
    }

    #[test]
    fn added_context_is_joined_with_plain_stdout_on_prompt_events() {
        let json_ctx = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "from json"}}"#,
            "",
        );
        let plain = out(0, "from plain stdout\n", "");
        let r = respond("UserPromptSubmit", &answers(&[json_ctx, plain]));
        assert_eq!(
            json_of(&r),
            json!({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                "additionalContext": "from json\n\nfrom plain stdout"}})
        );
    }

    #[test]
    fn plain_stdout_is_not_context_on_tool_events() {
        let plain = out(0, "chatter", "");
        let ctx = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "hint"}}"#,
            "",
        );
        let r = respond("PostToolUse", &answers(&[plain, ctx]));
        assert_eq!(
            json_of(&r)["hookSpecificOutput"]["additionalContext"],
            "hint"
        );
    }

    #[test]
    fn stop_blocks_when_any_handler_blocks() {
        let by_exit = out(2, "", "tests failed\n");
        let by_json = out(0, r#"{"decision": "block", "reason": "lint failed"}"#, "");
        let quiet = out(0, "", "");
        let r = respond("Stop", &answers(&[by_exit, quiet, by_json]));
        assert_eq!(r.exit, 0);
        assert_eq!(
            json_of(&r),
            json!({"decision": "block", "reason": "tests failed\nlint failed"})
        );
        assert_eq!(r.decision.as_deref(), Some("block"));
    }

    #[test]
    fn exit_code_events_keep_exit_two_for_a_merged_block() {
        let outs = [out(2, "", "not done\n"), out(2, "", "still not done\n")];
        let r = respond("TaskCompleted", &answers(&outs));
        assert_eq!(r.exit, 2);
        assert_eq!(
            String::from_utf8_lossy(&r.stderr),
            "not done\nstill not done\n"
        );
    }

    #[test]
    fn errors_alone_become_routes_own_non_blocking_error() {
        let outs = [
            out(1, "", "boom\nsecond line"),
            out(127, "", "bash: x: command not found"),
        ];
        let r = respond("SessionStart", &answers(&outs));
        assert_eq!(r.exit, 1);
        assert_eq!(
            String::from_utf8_lossy(&r.stderr),
            "route: a: Failed with non-blocking status code: boom; b: Failed with non-blocking status code: bash: x: command not found\n"
        );
    }

    #[test]
    fn errors_beside_a_decision_ride_in_system_message() {
        let outs = [out(1, "", "boom"), deny("no")];
        let r = respond("PreToolUse", &answers(&outs));
        let v = json_of(&r);
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            v["systemMessage"],
            "route: a: Failed with non-blocking status code: boom"
        );
    }

    #[test]
    fn valid_json_with_a_non_zero_exit_still_decides() {
        let mut d = deny("json wins");
        d.exit = Some(1);
        let e = normalize("PreToolUse", &answers(&[d])[0]);
        assert_eq!(e.permission, Some((Perm::Deny, "json wins".into())));
        assert_eq!(e.notice, None);
    }

    #[test]
    fn deprecated_block_and_approve_map_to_deny_and_allow() {
        let block = out(0, r#"{"decision": "block", "reason": "old style"}"#, "");
        let e = normalize("PreToolUse", &answers(&[block])[0]);
        assert_eq!(e.permission, Some((Perm::Deny, "old style".into())));
        let approve = out(0, r#"{"decision": "approve"}"#, "");
        let e = normalize("PreToolUse", &answers(&[approve])[0]);
        assert_eq!(e.permission, Some((Perm::Allow, String::new())));
    }

    #[test]
    fn stdout_classification_follows_claude_code() {
        assert_eq!(classify(""), Stdout::Empty);
        assert!(matches!(classify("hello"), Stdout::Plain(_)));
        assert!(matches!(classify("[1, 2]"), Stdout::Plain(_)));
        assert!(matches!(classify("{\"a\": 1}\n"), Stdout::Json(_)));
        assert!(matches!(classify("{not json}"), Stdout::Invalid(_)));
    }

    #[test]
    fn continue_false_and_extra_fields_survive_the_merge() {
        let stop = out(
            0,
            r#"{"continue": false, "stopReason": "halt", "suppressOutput": true}"#,
            "",
        );
        let title = out(
            0,
            r#"{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "sessionTitle": "t"}}"#,
            "",
        );
        let r = respond("UserPromptSubmit", &answers(&[stop, title]));
        assert_eq!(
            json_of(&r),
            json!({"continue": false, "stopReason": "halt", "suppressOutput": true,
                "hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "sessionTitle": "t"}})
        );
    }
}
