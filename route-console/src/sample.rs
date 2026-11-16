//! The design canvas's eight sample events, written as route would log them,
//! so the `canvas` scene renders the same rows as the Log artboard and the two
//! can be compared side by side.

use serde_json::{Value, json};

pub const DAY: &str = "2026-11-16";

const BASH: [(&str, u64); 7] = [
    ("bash ~/.claude/hooks/no-secrets.sh", 6),
    ("python3 ~/.claude/hooks/no-dangerous-rm.py", 24),
    ("python3 ~/.claude/hooks/no-dangerous.py", 33),
    ("bash ~/.claude/hooks/quiet-override.sh", 5),
    ("python3 ~/.claude/hooks/pipe-allow.py", 25),
    ("~/.local/bin/trinket-git-message", 3),
    ("bash ~/.claude/hooks/rg-glob-guard.sh", 7),
];

fn handler(command: &str, ms: u64) -> Value {
    json!({"matcher": "Bash", "command": command, "exit": 0, "ms": ms, "outcome": "none"})
}

fn decided(command: &str, ms: u64, decision: &str, reason: &str) -> Value {
    let out = json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
        "permissionDecision": decision, "permissionDecisionReason": reason}});
    json!({"matcher": "Bash", "command": command, "exit": 0, "ms": ms, "outcome": decision, "stdout": out.to_string()})
}

/// The Bash guards, with `changed` standing in for the named ones.
fn bash(changed: &[(&str, Value)]) -> Vec<Value> {
    BASH.iter()
        .map(|(cmd, ms)| {
            changed
                .iter()
                .find(|(name, _)| cmd.ends_with(name))
                .map_or_else(|| handler(cmd, *ms), |(_, h)| h.clone())
        })
        .collect()
}

fn line(
    time: &str,
    event: &str,
    tool: Option<&str>,
    input: Option<&str>,
    decision: Option<&str>,
    ms: u64,
    handlers: Vec<Value>,
) -> String {
    let mut v = json!({"v": 1, "ts": format!("{DAY}T{time}.000+05:00"), "event": event,
        "session_id": "f6fa9d22-sample", "cwd": "/Users/vadim/nix", "mode": "passthrough",
        "decision": decision, "exit": 0, "ms": ms, "handlers": handlers});
    if let Some(t) = tool {
        v["tool"] = t.into();
    }
    if let Some(i) = input {
        v["input"] = i.into();
    }
    let reasons: Vec<String> = v["handlers"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|h| decision.is_some() && h["outcome"].as_str() == decision)
        .filter_map(|h| serde_json::from_str::<Value>(h["stdout"].as_str()?).ok())
        .filter_map(|o| {
            o["hookSpecificOutput"]["permissionDecisionReason"]
                .as_str()
                .or(o["reason"].as_str())
                .map(String::from)
        })
        .filter(|r| !r.trim().is_empty())
        .collect();
    if !reasons.is_empty() {
        v["reasons"] = reasons.into();
        if v["reasons"].as_array().unwrap().len() > 1 {
            v["mode"] = "merged".into();
        }
    }
    v.to_string()
}

/// Line `n` of the `live` scene's endless feed: the sample events in turn, one
/// a second from 14:00:00, so a headless run can scroll a list that grows.
pub fn feed(samples: &[String], n: usize) -> String {
    let mut v: Value = serde_json::from_str(&samples[n % samples.len()]).expect("sample line");
    let s = 14 * 3600 + n;
    v["ts"] = format!(
        "{DAY}T{:02}:{:02}:{:02}.000+05:00",
        s / 3600 % 24,
        s / 60 % 60,
        s % 60
    )
    .into();
    v.to_string()
}

pub fn lines() -> Vec<String> {
    let dangerous = "python3 ~/.claude/hooks/no-dangerous.py";
    let rewrite = json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {"command": "make -s hi"}}});
    let context = json!({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Returned context for the model."}});
    let block = json!({"decision": "block", "reason": "Which alternative did you reject, and does the record name the trade-off you accepted?"});
    vec![
        line(
            "14:03:10",
            "PreToolUse",
            Some("Bash"),
            Some("git merge --ff-only claude/optimistic-khayyam-55e6b0"),
            Some("deny"),
            41,
            bash(&[(
                "no-dangerous.py",
                decided(dangerous, 33, "deny", "Blocked: rebase instead of merge"),
            )]),
        ),
        line(
            "14:04:40",
            "Stop",
            None,
            None,
            Some("block"),
            2302,
            vec![
                json!({"matcher": "", "command": "bash ~/.claude/hooks/sound.sh Stop", "async": true}),
                json!({"matcher": "", "command": "bash ~/.claude/hooks/stop-verify.sh", "exit": 0, "ms": 2300, "outcome": "block", "stdout": block.to_string()}),
            ],
        ),
        line(
            "14:05:02",
            "UserPromptSubmit",
            None,
            Some("Commit the working tree changes with a sensible message."),
            None,
            1183,
            vec![
                json!({"matcher": "", "command": "bash ~/.claude/hooks/turn-check.sh", "exit": 0, "ms": 210, "outcome": "none"}),
                json!({"matcher": "", "command": "~/.local/bin/trinket-claude-prompt", "exit": 0, "ms": 1180, "outcome": "context", "stdout": context.to_string()}),
            ],
        ),
        line(
            "14:06:30",
            "PostToolUse",
            Some("Edit"),
            Some("docs/spikes/2026-11-16-hook-route.md"),
            None,
            20,
            vec![
                json!({"matcher": "Write|Edit", "command": "bash ~/.claude/hooks/hint-autoformat.sh", "exit": 0, "ms": 18, "outcome": "context",
                "stdout": "Hint: autoformat formats this file; run it when you finish editing.\n"}),
            ],
        ),
        line(
            "14:07:55",
            "PreToolUse",
            Some("Bash"),
            Some("cat .env"),
            Some("allow"),
            34,
            bash(&[
                (
                    "no-secrets.sh",
                    json!({"matcher": "Bash", "command": "bash ~/.claude/hooks/no-secrets.sh", "exit": 1, "ms": 6, "outcome": "error",
                "stderr": "line 30: ${COMMAND,,}: bad substitution\n"}),
                ),
                (
                    "pipe-allow.py",
                    decided("python3 ~/.claude/hooks/pipe-allow.py", 25, "allow", ""),
                ),
            ]),
        ),
        line(
            "14:08:12",
            "PreToolUse",
            Some("mcp__visualize__show_widget"),
            Some("<div data-chart=\"mmd-3f2a91c0\" style=\"padding:1rem 0;…"),
            Some("deny"),
            49,
            vec![
                json!({"matcher": "mcp__visualize__show_widget", "command": "python3 ~/.claude/hooks/chart-verbatim.py", "exit": 0, "ms": 48, "outcome": "deny",
                "stdout": json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                    "permissionDecisionReason": "widget_code differs from the render.ts output, first at character 4,112."}}).to_string()}),
            ],
        ),
        line(
            "14:09:41",
            "PreToolUse",
            Some("Bash"),
            Some("make hi"),
            None,
            34,
            bash(&[(
                "quiet-override.sh",
                json!({"matcher": "Bash", "command": "bash ~/.claude/hooks/quiet-override.sh", "exit": 0, "ms": 5, "outcome": "rewrite", "stdout": rewrite.to_string()}),
            )]),
        ),
        line(
            "14:10:03",
            "PreToolUse",
            Some("Bash"),
            Some("git -C . log -1 && rg -g '!*.lock' route"),
            Some("deny"),
            41,
            bash(&[
                (
                    "no-dangerous.py",
                    decided(
                        dangerous,
                        33,
                        "deny",
                        "git -C is blocked: cd into the repository instead.",
                    ),
                ),
                (
                    "rg-glob-guard.sh",
                    decided(
                        "bash ~/.claude/hooks/rg-glob-guard.sh",
                        7,
                        "deny",
                        "A lone negated -g glob hides every other file: add a positive glob.",
                    ),
                ),
            ]),
        ),
    ]
}
