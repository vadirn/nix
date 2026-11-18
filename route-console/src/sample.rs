//! The design canvas's eight sample events, written as route would log them,
//! so the `canvas` scene renders the same rows as the Log artboard and the two
//! can be compared side by side; and the Codex events of its spaces artboard.

use serde_json::{Value, json};

use crate::space::Harness;

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
    harness: Harness,
    time: &str,
    event: &str,
    tool: Option<&str>,
    input: Option<&str>,
    decision: Option<&str>,
    ms: u64,
    handlers: Vec<Value>,
) -> String {
    let mut v = json!({"v": 1, "harness": harness.name(), "ts": format!("{DAY}T{time}.000+05:00"), "event": event,
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
            Harness::Claude,
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
            Harness::Claude,
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
            Harness::Claude,
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
            Harness::Claude,
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
            Harness::Claude,
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
            Harness::Claude,
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
            Harness::Claude,
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
            Harness::Claude,
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

/// The `health` scene's lines: the canvas's, plus handlers in trouble. A guard
/// that fails on two more Bash calls, a hook that times out, an async one that
/// cannot start, and one that writes to stderr at exit 0. Kept apart from
/// [`lines`], so the `canvas` scene still matches its artboard.
pub fn trouble_lines() -> Vec<String> {
    let secrets_failed = || {
        (
            "no-secrets.sh",
            json!({"matcher": "Bash", "command": "bash ~/.claude/hooks/no-secrets.sh", "exit": 1, "ms": 6, "outcome": "error",
                "stderr": "line 30: ${COMMAND,,}: bad substitution\n"}),
        )
    };
    let getcwd = "shell-init: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory\n";
    let mut out = lines();
    out.extend([
        line(
            Harness::Claude,
            "14:11:20",
            "PreToolUse",
            Some("Bash"),
            Some("ls -la ~/.claude"),
            None,
            35,
            bash(&[secrets_failed()]),
        ),
        line(
            Harness::Claude,
            "14:12:02",
            "Stop",
            None,
            None,
            None,
            812,
            vec![
                json!({"matcher": "", "command": "bash ~/.claude/hooks/sound.sh Stop", "async": true}),
                json!({"matcher": "", "command": "bash ~/.claude/hooks/stop-verify.sh", "exit": 0, "ms": 810, "outcome": "none", "stderr": getcwd}),
            ],
        ),
        line(
            Harness::Claude,
            "14:12:40",
            "UserPromptSubmit",
            None,
            Some("Run the tests again."),
            None,
            10004,
            vec![
                json!({"matcher": "", "command": "bash ~/.claude/hooks/turn-check.sh", "exit": null, "ms": 10001, "outcome": "error", "timed_out": true, "signal": 9}),
                json!({"matcher": "", "command": "~/.local/bin/trinket-claude-prompt", "exit": 0, "ms": 1020, "outcome": "none"}),
            ],
        ),
        line(
            Harness::Claude,
            "14:13:05",
            "Notification",
            None,
            None,
            None,
            2,
            vec![
                json!({"matcher": "", "command": "~/.local/bin/notify-done", "async": true, "spawn_error": "No such file or directory (os error 2)"}),
            ],
        ),
        line(
            Harness::Claude,
            "14:13:30",
            "PreToolUse",
            Some("Bash"),
            Some("printenv | rg TOKEN"),
            None,
            36,
            bash(&[secrets_failed()]),
        ),
        line(
            Harness::Claude,
            "14:14:10",
            "Stop",
            None,
            None,
            None,
            790,
            vec![
                json!({"matcher": "", "command": "bash ~/.claude/hooks/sound.sh Stop", "async": true}),
                json!({"matcher": "", "command": "bash ~/.claude/hooks/stop-verify.sh", "exit": 0, "ms": 788, "outcome": "none", "stderr": getcwd}),
            ],
        ),
    ]);
    out
}

const CODEX_STOP: &str =
    "~/.local/bin/trinket-codex-stop --global ~/.config/trinket/turn-check.json";
const CODEX_SHELL: &str = "Bash|exec_command|functions.exec_command";

/// Codex's Bash handlers, as `CODEX_HOOKS` lists them, with `changed`
/// standing in for the named ones.
fn codex_bash(changed: &[(&str, Value)]) -> Vec<Value> {
    let guards = [
        ("Bash", "python3 ~/.codex/hooks/direnv-env.py", 41),
        ("Bash", "bash ~/.claude/hooks/no-secrets.sh", 6),
        ("Bash", "python3 ~/.claude/hooks/no-dangerous-rm.py", 24),
        ("Bash", "python3 ~/.claude/hooks/no-dangerous.py", 33),
        ("Bash", "bash ~/.claude/hooks/rg-glob-guard.sh", 7),
        (CODEX_SHELL, CODEX_STOP, 12),
    ];
    guards
        .iter()
        .map(|(matcher, cmd, ms)| {
            changed
                .iter()
                .find(|(name, _)| cmd.contains(name))
                .map_or_else(
                    || json!({"matcher": matcher, "command": cmd, "exit": 0, "ms": ms, "outcome": "none"}),
                    |(_, h)| h.clone(),
                )
        })
        .collect()
}

/// The `spaces` scene's Codex events, after the design's spaces artboard: a
/// turn interrupted and one stopped, Bash calls run, denied and let through
/// with a guard writing to stderr, and a prompt given context. Codex's ask
/// (the artboard's `rm -rf`) is route's to map later; here a guard denies.
pub fn codex_lines() -> Vec<String> {
    let codex = Harness::Codex;
    let context = json!({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "Returned context for the model."}});
    let blocked = "direnv: error /Users/vadim/nix/.envrc is blocked. Run `direnv allow` to approve its content\n";
    vec![
        line(
            codex,
            "14:07:02",
            "Interrupt",
            None,
            None,
            None,
            10,
            vec![
                json!({"matcher": "", "command": CODEX_STOP, "exit": 0, "ms": 9, "outcome": "none"}),
            ],
        ),
        line(
            codex,
            "14:07:44",
            "Stop",
            None,
            None,
            None,
            1842,
            vec![
                json!({"matcher": "", "command": format!("{CODEX_STOP} --review ~/.config/trinket/turn-review.json"),
                "exit": 0, "ms": 1840, "outcome": "none"}),
            ],
        ),
        line(
            codex,
            "14:08:21",
            "PreToolUse",
            Some("Bash"),
            Some("direnv exec . cargo build"),
            None,
            43,
            codex_bash(&[(
                "direnv-env.py",
                json!({"matcher": "Bash", "command": "python3 ~/.codex/hooks/direnv-env.py", "exit": 0, "ms": 41,
                    "outcome": "none", "stderr": blocked}),
            )]),
        ),
        line(
            codex,
            "14:08:57",
            "UserPromptSubmit",
            None,
            Some("Add Codex to route’s log and handlers."),
            None,
            962,
            vec![
                json!({"matcher": "", "command": CODEX_STOP, "exit": 0, "ms": 14, "outcome": "none"}),
                json!({"matcher": "", "command": "~/.local/bin/trinket-codex-prompt --config ~/.config/trinket/turn-prompt.json",
                    "exit": 0, "ms": 960, "outcome": "context", "stdout": context.to_string()}),
            ],
        ),
        line(
            codex,
            "14:10:48",
            "PreToolUse",
            Some("Bash"),
            Some("rm -rf route/target"),
            Some("deny"),
            26,
            codex_bash(&[(
                "no-dangerous-rm.py",
                decided(
                    "python3 ~/.claude/hooks/no-dangerous-rm.py",
                    24,
                    "deny",
                    "rm -rf deletes for good: move it to the trash instead.",
                ),
            )]),
        ),
        line(
            codex,
            "14:11:20",
            "PreToolUse",
            Some("Bash"),
            Some("cargo test -p route --test route"),
            None,
            44,
            codex_bash(&[]),
        ),
        line(
            codex,
            "14:11:58",
            "PostToolUse",
            Some("Bash"),
            Some("cargo test -p route --test route"),
            None,
            13,
            vec![
                json!({"matcher": CODEX_SHELL, "command": CODEX_STOP, "exit": 0, "ms": 12, "outcome": "none"}),
            ],
        ),
    ]
}

/// The hooks file the Handlers artboard lists, for the sample scenes: they
/// show it, toggle it in memory, and replay against it, never against the
/// real one.
pub const HOOKS: &str = r#"{
  "route": {
    "builtins": {
      "bash ~/.claude/hooks/no-secrets.sh": "no-secrets",
      "python3 ~/.claude/hooks/no-dangerous-rm.py": "no-dangerous-rm",
      "python3 ~/.claude/hooks/no-dangerous.py": "no-dangerous",
      "bash ~/.claude/hooks/quiet-override.sh": "quiet-override",
      "python3 ~/.claude/hooks/pipe-allow.py": "pipe-allow",
      "bash ~/.claude/hooks/rg-glob-guard.sh": "rg-glob-guard"
    }
  },
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [
        {"type": "command", "command": "bash ~/.claude/hooks/no-secrets.sh"},
        {"type": "command", "command": "python3 ~/.claude/hooks/no-dangerous-rm.py"},
        {"type": "command", "command": "python3 ~/.claude/hooks/no-dangerous.py"},
        {"type": "command", "command": "bash ~/.claude/hooks/quiet-override.sh"},
        {"type": "command", "command": "python3 ~/.claude/hooks/pipe-allow.py"},
        {"type": "command", "command": "~/.local/bin/trinket-git-message", "timeout": 120},
        {"type": "command", "command": "bash ~/.claude/hooks/rg-glob-guard.sh"}
      ]},
      {"matcher": "Read", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/no-secrets-read.sh"}]},
      {"matcher": "Grep", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/no-secrets-read.sh"}]},
      {"matcher": "^(WebSearch|WebFetch)$", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/prefer-firecrawl.sh"}]},
      {"matcher": "^mcp__visualize__show_widget$", "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/chart-verbatim.py"}]},
      {"matcher": "^Bash$", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/turn-check.sh", "timeout": 30}]}
    ],
    "PostToolUse": [
      {"matcher": "^(Write|Edit)$", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/hint-autoformat.sh", "timeout": 5}]},
      {"matcher": "^Bash$", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/turn-check.sh", "timeout": 30}]}
    ],
    "PostToolUseFailure": [
      {"matcher": "^Bash$", "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/turn-check.sh", "timeout": 30}]}
    ],
    "UserPromptSubmit": [{"hooks": [
      {"type": "command", "command": "bash ~/.claude/hooks/turn-check.sh", "timeout": 30},
      {"type": "command", "command": "~/.local/bin/trinket-claude-prompt --config ~/.config/trinket/turn-prompt.json", "timeout": 30}
    ]}],
    "Stop": [{"hooks": [
      {"type": "command", "command": "bash ~/.claude/hooks/sound.sh Stop", "timeout": 5, "async": true},
      {"type": "command", "command": "bash ~/.claude/hooks/stop-verify.sh", "timeout": 120}
    ]}],
    "StopFailure": [{"hooks": [{"type": "command", "command": "bash ~/.claude/hooks/turn-check.sh", "timeout": 30}]}],
    "SessionStart": [{"hooks": [
      {"type": "command", "command": "mkdir -p /tmp/claude", "timeout": 5},
      {"type": "command", "command": "bash ~/.claude/hooks/sandbox-nc-path.sh", "timeout": 5},
      {"type": "command", "command": "python3 ~/.claude/hooks/direnv-env.py", "timeout": 30}
    ]}],
    "CwdChanged": [{"hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/direnv-env.py", "timeout": 30}]}],
    "SessionEnd": [{"hooks": [{"type": "command", "command": "bash ~/.claude/hooks/turn-check.sh", "timeout": 3}]}],
    "Notification": [{"hooks": [{"type": "command", "command": "bash ~/.claude/hooks/sound.sh Notification", "timeout": 5, "async": true}]}],
    "TaskCompleted": [{"hooks": [{"type": "command", "command": "bash ~/.claude/hooks/sound.sh TaskCompleted", "timeout": 5, "async": true}]}]
  }
}"#;

/// Codex's hooks file for the sample scenes: route's 7 Codex hooks, and the
/// four Bash guards route runs in-process.
pub const CODEX_HOOKS: &str = r#"{
  "route": {
    "builtins": {
      "bash ~/.claude/hooks/no-secrets.sh": "no-secrets",
      "python3 ~/.claude/hooks/no-dangerous-rm.py": "no-dangerous-rm",
      "python3 ~/.claude/hooks/no-dangerous.py": "no-dangerous",
      "bash ~/.claude/hooks/rg-glob-guard.sh": "rg-glob-guard"
    }
  },
  "hooks": {
    "PreToolUse": [
      {"matcher": "Bash", "hooks": [
        {"type": "command", "command": "python3 ~/.codex/hooks/direnv-env.py", "timeout": 5},
        {"type": "command", "command": "bash ~/.claude/hooks/no-secrets.sh"},
        {"type": "command", "command": "python3 ~/.claude/hooks/no-dangerous-rm.py"},
        {"type": "command", "command": "python3 ~/.claude/hooks/no-dangerous.py"},
        {"type": "command", "command": "bash ~/.claude/hooks/rg-glob-guard.sh"}
      ]},
      {"matcher": "Bash|exec_command|functions.exec_command", "hooks": [
        {"type": "command", "command": "~/.local/bin/trinket-codex-stop --global ~/.config/trinket/turn-check.json", "timeout": 30}
      ]}
    ],
    "UserPromptSubmit": [{"hooks": [
      {"type": "command", "command": "~/.local/bin/trinket-codex-stop --global ~/.config/trinket/turn-check.json", "timeout": 30},
      {"type": "command", "command": "~/.local/bin/trinket-codex-prompt --config ~/.config/trinket/turn-prompt.json", "timeout": 30}
    ]}],
    "PostToolUse": [{"matcher": "Bash|exec_command|functions.exec_command", "hooks": [
      {"type": "command", "command": "~/.local/bin/trinket-codex-stop --global ~/.config/trinket/turn-check.json", "timeout": 30}
    ]}],
    "Stop": [{"hooks": [
      {"type": "command", "command": "~/.local/bin/trinket-codex-stop --global ~/.config/trinket/turn-check.json --review ~/.config/trinket/turn-review.json", "timeout": 60}
    ]}],
    "Interrupt": [{"hooks": [
      {"type": "command", "command": "~/.local/bin/trinket-codex-stop --global ~/.config/trinket/turn-check.json", "timeout": 3}
    ]}]
  }
}"#;

/// One harness's sample hooks file, as text.
pub fn hooks_text(harness: Harness) -> &'static str {
    match harness {
        Harness::Claude => HOOKS,
        Harness::Codex => CODEX_HOOKS,
    }
}

pub fn hooks(harness: Harness) -> Value {
    serde_json::from_str(hooks_text(harness)).expect("sample hooks parse")
}
