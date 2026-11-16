//! Bash guards that run inside route instead of as scripts.
//!
//! The hooks file keeps each guard's script command, so state.json toggles
//! and a paste back into settings.json both still work. The `route.builtins`
//! map names the commands route serves in-process:
//!
//! ```json
//! "route": {"builtins": {"python3 ~/.claude/hooks/no-dangerous.py": "no-dangerous"}}
//! ```
//!
//! Every guard reads one parse of the command (`shell::parse`), made once per
//! event and shared. A guard answers with the JSON its script printed, wrapped
//! in an `Outcome`, so the merge and the log read it as any handler's answer.

use std::cell::{Cell, OnceCell};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::time::Instant;

use serde_json::{Value, json};

use crate::run::Outcome;
use crate::shell::{self, Script};

mod no_dangerous;
mod no_dangerous_rm;
mod no_secrets;
mod pipe_allow;
mod quiet_override;
mod rg_glob;

/// What a guard tells Claude Code about one Bash call.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    None,
    Deny(String),
    Allow(String),
    /// The command to run instead.
    Rewrite(String),
}

pub struct Guard {
    pub name: &'static str,
    check: fn(&Ctx) -> Verdict,
}

impl std::fmt::Debug for Guard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Guard({})", self.name)
    }
}

pub const ALL: &[Guard] = &[
    Guard {
        name: "no-secrets",
        check: no_secrets::check,
    },
    Guard {
        name: "no-dangerous-rm",
        check: no_dangerous_rm::check,
    },
    Guard {
        name: "no-dangerous",
        check: no_dangerous::check,
    },
    Guard {
        name: "quiet-override",
        check: quiet_override::check,
    },
    Guard {
        name: "pipe-allow",
        check: pipe_allow::check,
    },
    Guard {
        name: "rg-glob-guard",
        check: rg_glob::check,
    },
];

pub fn lookup(name: &str) -> Option<&'static Guard> {
    ALL.iter().find(|g| g.name == name)
}

/// One Bash call as the guards see it, with its parse made on first use.
pub struct Ctx<'a> {
    pub command: Option<&'a str>,
    pub cwd: &'a str,
    /// `$HOME`, for `~` in paths.
    pub home: String,
    /// The settings file whose `permissions.allow` pipe-allow reads.
    pub settings: PathBuf,
    script: OnceCell<Script>,
    literal: OnceCell<Script>,
}

impl<'a> Ctx<'a> {
    pub fn new(payload: &'a Value) -> Ctx<'a> {
        let home = std::env::var("HOME").unwrap_or_default();
        let settings = PathBuf::from(&home).join(".claude/settings.json");
        Ctx::with(payload, home, settings)
    }

    pub fn with(payload: &'a Value, home: String, settings: PathBuf) -> Ctx<'a> {
        Ctx {
            command: payload
                .get("tool_input")
                .and_then(|t| t.get("command"))
                .and_then(Value::as_str),
            cwd: payload.get("cwd").and_then(Value::as_str).unwrap_or(""),
            home,
            settings,
            script: OnceCell::new(),
            literal: OnceCell::new(),
        }
    }

    /// The shared parse. An absent command parses as empty.
    pub fn script(&self) -> &Script {
        self.script
            .get_or_init(|| shell::parse(self.command.unwrap_or("")))
    }

    /// What a denying guard checks: the parse, then, when a quote or
    /// substitution ran off the end, the literal parse as well, so an
    /// unbalanced quote cannot hide the words after it.
    pub fn scripts(&self) -> Vec<&Script> {
        let s = self.script();
        if !s.incomplete {
            return vec![s];
        }
        let l = self
            .literal
            .get_or_init(|| shell::parse_literal(self.command.unwrap_or("")));
        vec![s, l]
    }
}

thread_local! {
    static IN_GUARD: Cell<bool> = const { Cell::new(false) };
}

/// True while a guard runs, so route's panic hook lets the panic unwind to
/// `run` instead of failing route: a guard that crashes is a handler that
/// failed, as a crashed script was.
pub fn in_guard() -> bool {
    IN_GUARD.with(Cell::get)
}

/// Runs one guard and wraps its verdict as the answer its script gave.
pub fn run(g: &Guard, ctx: &Ctx) -> Outcome {
    let started = Instant::now();
    IN_GUARD.with(|f| f.set(true));
    let result = catch_unwind(AssertUnwindSafe(|| (g.check)(ctx)));
    IN_GUARD.with(|f| f.set(false));
    let us = started.elapsed().as_micros() as u64;
    let mut o = Outcome {
        exit: Some(0),
        us: Some(us),
        ..Outcome::default()
    };
    match result {
        Ok(v) => {
            if let Some(json) = answer(&v) {
                o.stdout = format!("{json}\n").into_bytes();
            }
        }
        Err(panic) => {
            let msg = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            o.exit = Some(1);
            o.stderr = format!("{} panicked: {msg}\n", g.name).into_bytes();
        }
    }
    o
}

fn answer(v: &Verdict) -> Option<Value> {
    let hso = match v {
        Verdict::None => return None,
        Verdict::Deny(r) => json!({
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": r,
        }),
        Verdict::Allow(r) => json!({
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": r,
        }),
        Verdict::Rewrite(c) => json!({
            "hookEventName": "PreToolUse",
            "updatedInput": {"command": c},
        }),
    };
    Some(json!({ "hookSpecificOutput": hso }))
}

/// The first deny across `scripts`, checked in order.
fn first_deny<'s>(
    scripts: &[&'s Script],
    mut check: impl FnMut(&'s Script) -> Option<String>,
) -> Verdict {
    scripts
        .iter()
        .find_map(|s| check(s))
        .map_or(Verdict::None, Verdict::Deny)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One fixture file: the cases a guard's script test checked, plus the
    /// cases where reading the shared parse changes its decision. `expect` is
    /// the builtin's answer; `script`, when present, is the old script's.
    const FIXTURES: &[(&str, &str)] = &[
        (
            "no-secrets",
            include_str!("../../tests/guards/no-secrets.json"),
        ),
        (
            "no-dangerous-rm",
            include_str!("../../tests/guards/no-dangerous-rm.json"),
        ),
        (
            "no-dangerous",
            include_str!("../../tests/guards/no-dangerous.json"),
        ),
        (
            "quiet-override",
            include_str!("../../tests/guards/quiet-override.json"),
        ),
        (
            "pipe-allow",
            include_str!("../../tests/guards/pipe-allow.json"),
        ),
        (
            "rg-glob-guard",
            include_str!("../../tests/guards/rg-glob-guard.json"),
        ),
    ];

    fn verdict_of(expect: &Value) -> Verdict {
        match expect {
            Value::String(s) if s == "none" => Verdict::None,
            Value::String(s) if s == "deny" => Verdict::Deny(String::new()),
            Value::String(s) if s == "allow" => Verdict::Allow(String::new()),
            Value::Object(m) if m.contains_key("rewrite") => {
                Verdict::Rewrite(m["rewrite"].as_str().unwrap().to_string())
            }
            other => panic!("bad expect {other}"),
        }
    }

    fn same(got: &Verdict, want: &Verdict) -> bool {
        match (got, want) {
            (Verdict::Deny(_), Verdict::Deny(_)) | (Verdict::Allow(_), Verdict::Allow(_)) => true,
            _ => got == want,
        }
    }

    #[test]
    fn every_fixture_case_holds() {
        let dir = std::env::temp_dir().join(format!("route-guards-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut failures = Vec::new();
        let mut count = 0;
        for (name, text) in FIXTURES {
            let file: Value = serde_json::from_str(text).unwrap();
            assert_eq!(file["guard"], *name);
            let guard = lookup(name).unwrap();
            let settings = dir.join(format!("{name}-settings.json"));
            let allow = file.get("settings_allow").cloned().unwrap_or(json!([]));
            std::fs::write(
                &settings,
                json!({"permissions": {"allow": allow}}).to_string(),
            )
            .unwrap();
            // `tree` lays out files under a temp root that `{root}` names:
            // a path ending in `/` is a directory, any other a file.
            let root = dir.join(format!("{name}-tree"));
            for entry in file
                .get("tree")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let entry = entry.as_str().unwrap();
                let path = root.join(entry.trim_end_matches('/'));
                if entry.ends_with('/') {
                    std::fs::create_dir_all(&path).unwrap();
                } else {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    std::fs::write(&path, "gitdir: elsewhere\n").unwrap();
                }
            }
            let fill = |s: &str| s.replace("{root}", root.to_str().unwrap());
            let default_cwd = file.get("cwd").and_then(Value::as_str).unwrap_or("");
            for case in file["cases"].as_array().unwrap() {
                count += 1;
                let cwd = fill(
                    case.get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or(default_cwd),
                );
                let command = fill(case["command"].as_str().unwrap());
                let payload = json!({"tool_input": {"command": command}, "cwd": cwd});
                let ctx = Ctx::with(&payload, "/Users/vadim".into(), settings.clone());
                let got = (guard.check)(&ctx);
                let want = verdict_of(&case["expect"]);
                let reason_ok = match (&got, case.get("reason")) {
                    (Verdict::Deny(r) | Verdict::Allow(r), Some(want)) => {
                        r.contains(want.as_str().unwrap())
                    }
                    _ => true,
                };
                if !same(&got, &want) || !reason_ok {
                    failures.push(format!("{name}: {}: got {got:?}", case["name"]));
                }
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(count > 250, "only {count} cases");
        assert!(
            failures.is_empty(),
            "{} of {count} failed:\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    #[test]
    fn a_guard_panic_becomes_a_failed_handler() {
        fn boom(_: &Ctx) -> Verdict {
            panic!("kaboom")
        }
        let g = Guard {
            name: "boom",
            check: boom,
        };
        let payload = json!({"tool_input": {"command": "ls"}});
        let o = run(&g, &Ctx::new(&payload));
        assert_eq!(o.exit, Some(1));
        assert!(String::from_utf8_lossy(&o.stderr).contains("boom panicked: kaboom"));
        assert!(!in_guard());
    }

    #[test]
    fn verdicts_print_the_scripts_json() {
        let payload = json!({"tool_input": {"command": "sudo ls"}});
        let o = run(lookup("no-dangerous").unwrap(), &Ctx::new(&payload));
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        let quiet = json!({"tool_input": {"command": "make"}});
        let o = run(lookup("quiet-override").unwrap(), &Ctx::new(&quiet));
        let v: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert_eq!(
            v["hookSpecificOutput"]["updatedInput"],
            json!({"command": "make -s"})
        );
        let none = json!({"tool_input": {"command": "ls"}});
        assert!(
            run(lookup("no-dangerous").unwrap(), &Ctx::new(&none))
                .stdout
                .is_empty()
        );
    }
}
