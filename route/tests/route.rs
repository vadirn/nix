//! End-to-end: the built `route` binary against `/bin/sh` fixture handlers.

use std::fs;
use std::io::Write;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

struct Fixture {
    dir: PathBuf,
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

impl Fixture {
    fn new() -> Fixture {
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("route-e2e-{}-{n}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Fixture { dir }
    }

    /// Writes a handler script and returns the command that runs it.
    fn handler(&self, name: &str, body: &str) -> String {
        let path = self.dir.join(name);
        fs::write(&path, body).unwrap();
        format!("sh {}", path.display())
    }

    fn config(&self, hooks: Value) {
        fs::write(self.dir.join("hooks.json"), hooks.to_string()).unwrap();
    }

    fn state(&self, state: Value) {
        fs::write(self.dir.join("state.json"), state.to_string()).unwrap();
    }

    fn command(&self, event: &str) -> Command {
        self.command_as(None, event)
    }

    /// The route command for `event`, as `harness`'s settings call it; `None`
    /// passes no `--harness`, as Claude Code's do.
    fn command_as(&self, harness: Option<&str>, event: &str) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_route"));
        if let Some(h) = harness {
            c.args(["--harness", h]);
        }
        c.arg("--config")
            .arg(self.dir.join("hooks.json"))
            .arg("--state")
            .arg(self.dir.join("state.json"))
            .arg("--log-dir")
            .arg(self.log_dir())
            .arg(event);
        c
    }

    fn run(&self, event: &str, payload: &Value) -> Ran {
        self.run_bytes(event, payload.to_string().as_bytes())
    }

    fn run_bytes(&self, event: &str, payload: &[u8]) -> Ran {
        ran(self.command(event), payload)
    }

    fn run_as(&self, harness: &str, event: &str, payload: &Value) -> Ran {
        ran(
            self.command_as(Some(harness), event),
            payload.to_string().as_bytes(),
        )
    }

    fn log_dir(&self) -> PathBuf {
        self.dir.join("log")
    }

    fn log_lines(&self) -> Vec<Value> {
        log_lines(&self.log_dir())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn log_lines(dir: &Path) -> Vec<Value> {
    let mut lines = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let text = fs::read_to_string(entry.unwrap().path()).unwrap();
        for line in text.lines() {
            lines.push(serde_json::from_str(line).expect("a whole JSON line"));
        }
    }
    lines
}

/// Runs `cmd` with `payload` on stdin.
fn ran(mut cmd: Command, payload: &[u8]) -> Ran {
    let started = Instant::now();
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(payload).unwrap();
    let out = child.wait_with_output().unwrap();
    Ran {
        exit: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8(out.stderr).unwrap(),
        took: started.elapsed(),
    }
}

struct Ran {
    exit: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
    took: Duration,
}

impl Ran {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.stdout).expect("stdout is JSON")
    }
}

fn bash_call(command: &str) -> Value {
    json!({
        "session_id": "s1",
        "cwd": "/tmp",
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command}
    })
}

fn deny_script(reason: &str) -> String {
    format!(
        "cat >/dev/null\nprintf '%s' '{}'\n",
        json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": "deny", "permissionDecisionReason": reason}})
    )
}

fn group(matcher: &str, commands: &[&str]) -> Value {
    let hooks: Vec<Value> = commands
        .iter()
        .map(|c| json!({"type": "command", "command": c, "timeout": 10}))
        .collect();
    json!({"matcher": matcher, "hooks": hooks})
}

#[test]
fn a_lone_handler_passes_its_exit_code_stdout_and_stderr_through() {
    let f = Fixture::new();
    let quiet = f.handler("quiet.sh", "cat >/dev/null\n");
    let blocker = f.handler(
        "blocker.sh",
        "cat >/dev/null\nprintf 'plain stdout'\nprintf 'blocked: reason one\\nline two\\n' >&2\nexit 2\n",
    );
    f.config(json!({"hooks": {"PreToolUse": [group("Bash", &[&quiet, &blocker, &quiet])]}}));
    let r = f.run("PreToolUse", &bash_call("ls"));
    assert_eq!(r.exit, Some(2));
    assert_eq!(r.stdout, b"plain stdout");
    assert_eq!(r.stderr, "blocked: reason one\nline two\n");

    let failing = f.handler("failing.sh", "echo 'something broke' >&2\nexit 1\n");
    f.config(json!({"hooks": {"SessionStart": [group("", &[&failing])]}}));
    let r = f.run(
        "SessionStart",
        &json!({"hook_event_name": "SessionStart", "source": "startup"}),
    );
    assert_eq!(r.exit, Some(1));
    assert_eq!(r.stderr, "something broke\n");

    let json_out =
        r#"{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"hint"}}"#;
    let hint = f.handler(
        "hint.sh",
        &format!("cat >/dev/null\nprintf '%s\\n' '{json_out}'\n"),
    );
    f.config(json!({"hooks": {"PostToolUse": [group("^(Write|Edit)$", &[&hint])]}}));
    let r = f.run(
        "PostToolUse",
        &json!({"hook_event_name": "PostToolUse", "tool_name": "Edit"}),
    );
    assert_eq!(r.exit, Some(0));
    assert_eq!(
        String::from_utf8(r.stdout).unwrap(),
        format!("{json_out}\n")
    );
}

#[test]
fn several_answers_merge_into_one_response() {
    let f = Fixture::new();
    let a = f.handler("a.sh", &deny_script("rule a"));
    let b = f.handler("b.sh", &deny_script("rule b"));
    let rewrite = f.handler(
        "rewrite.sh",
        "cat >/dev/null\nprintf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"make -s\"}}}'\n",
    );
    f.config(
        json!({"hooks": {"PreToolUse": [group("Bash", &[&a, &rewrite]), group("^Bash$", &[&b])]}}),
    );
    let r = f.run("PreToolUse", &bash_call("make"));
    assert_eq!(r.exit, Some(0));
    assert_eq!(
        r.json(),
        json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
            "permissionDecision": "deny", "permissionDecisionReason": "rule a\nrule b"}})
    );

    // Without the denials, the rewrite goes through.
    f.config(json!({"hooks": {"PreToolUse": [group("Bash", &[&rewrite])]}}));
    let r = f.run("PreToolUse", &bash_call("make"));
    assert_eq!(
        r.json()["hookSpecificOutput"]["updatedInput"]["command"],
        "make -s"
    );
}

#[test]
fn stop_blocks_with_every_reason() {
    let f = Fixture::new();
    let tests = f.handler(
        "tests.sh",
        "cat >/dev/null\necho 'tests failed' >&2\nexit 2\n",
    );
    let lint = f.handler(
        "lint.sh",
        "cat >/dev/null\nprintf '%s' '{\"decision\":\"block\",\"reason\":\"lint failed\"}'\n",
    );
    f.config(json!({"hooks": {"Stop": [group("", &[&tests, &lint])]}}));
    let r = f.run(
        "Stop",
        &json!({"hook_event_name": "Stop", "stop_hook_active": false}),
    );
    assert_eq!(r.exit, Some(0));
    assert_eq!(
        r.json(),
        json!({"decision": "block", "reason": "tests failed\nlint failed"})
    );
}

#[test]
fn prompt_context_joins_plain_stdout_and_additional_context() {
    let f = Fixture::new();
    let plain = f.handler("plain.sh", "cat >/dev/null\necho 'plain context'\n");
    let ctx = f.handler(
        "ctx.sh",
        "cat >/dev/null\nprintf '%s' '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"json context\"}}'\n",
    );
    f.config(json!({"hooks": {"UserPromptSubmit": [group("", &[&plain, &ctx])]}}));
    let r = f.run(
        "UserPromptSubmit",
        &json!({"hook_event_name": "UserPromptSubmit", "prompt": "hi"}),
    );
    assert_eq!(
        r.json()["hookSpecificOutput"]["additionalContext"],
        "plain context\n\njson context"
    );
}

#[test]
fn concurrent_route_processes_write_whole_lines() {
    let f = Fixture::new();
    f.config(json!({
        "route": {"log": {"max_input_chars": 1_000_000}},
        "hooks": {"PreToolUse": []}
    }));
    let processes = 24;
    let children: Vec<_> = (0..processes)
        .map(|i| {
            let mut child = f
                .command("PreToolUse")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let command = format!("{i:03}-").repeat(30_000);
            let payload = bash_call(&command).to_string();
            let mut stdin = child.stdin.take().unwrap();
            std::thread::spawn(move || stdin.write_all(payload.as_bytes()).unwrap());
            child
        })
        .collect();
    for mut c in children {
        assert!(c.wait().unwrap().success());
    }
    let lines = f.log_lines();
    assert_eq!(lines.len(), processes);
    let mut seen: Vec<String> = lines
        .iter()
        .map(|l| {
            let input = l["input"].as_str().unwrap();
            let head = &input[..4];
            assert_eq!(
                input,
                head.repeat(30_000),
                "a line carries one process's input, whole"
            );
            head.to_string()
        })
        .collect();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), processes);
}

#[test]
fn the_log_line_records_handlers_and_truncates_input() {
    let f = Fixture::new();
    let a = f.handler("a.sh", &deny_script("rule a"));
    let noisy = f.handler(
        "noisy.sh",
        "cat >/dev/null\nprintf 'x%.0s' $(seq 1 50) >&2\n",
    );
    let off = f.handler("off.sh", &deny_script("switched off"));
    f.config(json!({
        "route": {"log": {"max_input_chars": 10, "max_output_chars": 20}},
        "hooks": {"PreToolUse": [group("Bash", &[&a, &noisy, &off])]}
    }));
    f.state(json!({"disabled": [{"event": "PreToolUse", "matcher": "Bash", "command": off}]}));
    let r = f.run("PreToolUse", &bash_call("echo a long command line"));
    assert_eq!(r.exit, Some(0));
    assert_eq!(
        r.json()["hookSpecificOutput"]["permissionDecisionReason"],
        "rule a"
    );
    let lines = f.log_lines();
    assert_eq!(lines.len(), 1);
    let l = &lines[0];
    assert_eq!(l["event"], "PreToolUse");
    assert_eq!(l["tool"], "Bash");
    assert_eq!(l["session_id"], "s1");
    assert_eq!(l["input"], "echo a lon…[+14 chars]");
    assert_eq!(l["mode"], "passthrough");
    assert_eq!(l["decision"], "deny");
    assert_eq!(l["reasons"], json!(["rule a"]));
    assert_eq!(l["handlers"][0]["outcome"], "deny");
    assert_eq!(
        l["handlers"][1]["stderr"],
        format!("{}…[+30 chars]", "x".repeat(20))
    );
    assert_eq!(l["skipped"][0]["command"], off);
    assert_eq!(l["handlers"].as_array().unwrap().len(), 2);
}

#[test]
fn a_route_failure_blocks_pre_tool_use_and_nothing_else() {
    let f = Fixture::new();
    // No hooks file at all.
    let r = f.run("PreToolUse", &bash_call("ls"));
    assert_eq!(r.exit, Some(2));
    assert!(r.stderr.starts_with("route: hooks file "), "{}", r.stderr);
    let r = f.run("Stop", &json!({"hook_event_name": "Stop"}));
    assert_eq!(r.exit, Some(1));

    f.config(json!({"hooks": {}}));
    let r = f.run_bytes("PreToolUse", b"not json");
    assert_eq!(r.exit, Some(2));
    assert!(r.stderr.contains("stdin is not JSON"), "{}", r.stderr);

    // A field route does not implement is a config failure, not a skipped filter.
    f.config(
        json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "true", "if": "Bash(git *)"}
        ]}]}}),
    );
    let r = f.run("PreToolUse", &bash_call("ls"));
    assert_eq!(r.exit, Some(2));
    assert!(r.stderr.contains("`if`"), "{}", r.stderr);
}

#[test]
fn a_slow_handler_times_out_without_blocking() {
    let f = Fixture::new();
    let slow = f.handler("slow.sh", "sleep 30\n");
    f.config(
        json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": slow, "timeout": 0.5}
        ]}]}}),
    );
    let r = f.run("PreToolUse", &bash_call("ls"));
    // Exit 0, not 1: route's PreToolUse entry blocks on any other exit.
    assert_eq!(r.exit, Some(0));
    let msg = r.json()["systemMessage"].as_str().unwrap().to_string();
    assert!(msg.contains("timed out after 0.5s"), "{msg}");
    assert!(r.took < Duration::from_secs(3), "{:?}", r.took);
    let line = &f.log_lines()[0];
    assert_eq!(line["handlers"][0]["timed_out"], true);
    assert_eq!(line["mode"], "rewritten");
}

#[test]
fn a_signal_to_route_takes_its_running_handlers_down() {
    let f = Fixture::new();
    let pids = f.dir.join("pids");
    // The background child proves the whole group goes, not just the leader.
    let slow = f.handler(
        "slow.sh",
        &format!(
            "sleep 30 &\necho $! >> {p}\necho $$ >> {p}\nsleep 30\n",
            p = pids.display()
        ),
    );
    f.config(
        json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": slow, "timeout": 60}
        ]}]}}),
    );
    let mut route = f
        .command("PreToolUse")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    route
        .stdin
        .take()
        .unwrap()
        .write_all(bash_call("ls").to_string().as_bytes())
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let started: Vec<i32> = loop {
        let got: Vec<i32> = fs::read_to_string(&pids)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect();
        if got.len() == 2 {
            break got;
        }
        assert!(Instant::now() < deadline, "the handler never started");
        std::thread::sleep(Duration::from_millis(20));
    };

    // SAFETY: a signal to the route child this test spawned.
    unsafe {
        libc::kill(route.id() as i32, libc::SIGTERM);
    }
    assert_eq!(route.wait().unwrap().signal(), Some(libc::SIGTERM));

    let deadline = Instant::now() + Duration::from_secs(3);
    for pid in started {
        // SAFETY: signal 0 only checks whether the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 {
            assert!(Instant::now() < deadline, "pid {pid} outlived route");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn async_handlers_neither_delay_nor_speak() {
    let f = Fixture::new();
    let marker = f.dir.join("async-ran");
    let background = f.handler(
        "background.sh",
        &format!("cat > {}\necho 'async stdout'\nsleep 3\n", marker.display()),
    );
    f.config(json!({"hooks": {"Stop": [{"hooks": [
        {"type": "command", "command": background, "async": true, "timeout": 5}
    ]}]}}));
    let payload = json!({"hook_event_name": "Stop", "session_id": "s2"});
    let r = f.run("Stop", &payload);
    assert_eq!(r.exit, Some(0));
    assert!(r.stdout.is_empty() && r.stderr.is_empty());
    assert!(r.took < Duration::from_secs(2), "{:?}", r.took);
    // The async handler got the whole payload.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if fs::read_to_string(&marker).ok().as_deref() == Some(payload.to_string().as_str()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("the async handler never wrote the payload it read");
}

#[test]
fn settings_prints_the_hooks_block_for_route() {
    let f = Fixture::new();
    f.config(json!({"hooks": {
        "PreToolUse": [group("Bash", &["a"]), group("^mcp__visualize__show_widget$", &["b"])],
        "SessionEnd": [{"hooks": [{"type": "command", "command": "c", "timeout": 3}]}]
    }}));
    let out = Command::new(env!("CARGO_BIN_EXE_route"))
        .arg("--config")
        .arg(f.dir.join("hooks.json"))
        .args(["settings", "--bin", "/opt/route"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let block: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        block,
        json!({"hooks": {
            "PreToolUse": [{"matcher": "Bash|mcp__visualize__show_widget", "hooks": [
                {"type": "command", "command": "/opt/route PreToolUse", "timeout": 12,
                    "onFailure": "block"}
            ]}],
            "SessionEnd": [{"hooks": [
                {"type": "command", "command": "/opt/route SessionEnd", "timeout": 5}
            ]}]
        }})
    );
}

#[test]
fn builtins_answer_in_process_beside_scripts_and_toggle_off_by_command() {
    let f = Fixture::new();
    // The mapped command does not exist, so only the in-process guard can answer.
    let guard = "python3 /nonexistent/no-dangerous.py";
    let script = f.handler("deny.sh", &deny_script("from the script"));
    f.config(json!({
        "route": {"builtins": {guard: "no-dangerous"}},
        "hooks": {"PreToolUse": [group("Bash", &[guard, &script])]}
    }));
    let ran = f.run("PreToolUse", &bash_call("sudo ls"));
    assert_eq!(ran.exit, Some(0));
    let hso = &ran.json()["hookSpecificOutput"];
    assert_eq!(hso["permissionDecision"], "deny");
    // Both reasons, in config order: the guard's first.
    assert_eq!(
        hso["permissionDecisionReason"],
        "Blocked: sudo runs commands as root. Too risky.\nfrom the script"
    );
    let line = f.log_lines().pop().unwrap();
    assert_eq!(line["handlers"][0]["builtin"], "no-dangerous");
    assert!(line["handlers"][0]["us"].is_u64());
    assert!(line["handlers"][1].get("builtin").is_none());

    f.state(json!({"disabled": [{"event": "PreToolUse", "matcher": "Bash", "command": guard}]}));
    let ran = f.run("PreToolUse", &bash_call("sudo ls"));
    assert_eq!(
        ran.json()["hookSpecificOutput"]["permissionDecisionReason"],
        "from the script"
    );
}

#[test]
fn a_builtin_name_this_binary_lacks_runs_the_command() {
    let f = Fixture::new();
    let script = f.handler("deny.sh", &deny_script("the script ran"));
    f.config(json!({
        "route": {"builtins": {script.clone(): "no-such-guard"}},
        "hooks": {"PreToolUse": [group("Bash", &[&script])]}
    }));
    let ran = f.run("PreToolUse", &bash_call("ls"));
    assert_eq!(
        ran.json()["hookSpecificOutput"]["permissionDecisionReason"],
        "the script ran"
    );
    let line = f.log_lines().pop().unwrap();
    assert!(line["notes"][0].as_str().unwrap().contains("no-such-guard"));
}

#[test]
fn a_rewrite_from_a_builtin_reaches_claude_code() {
    let f = Fixture::new();
    let guard = "bash /nonexistent/quiet-override.sh";
    f.config(json!({
        "route": {"builtins": {guard: "quiet-override"}},
        "hooks": {"PreToolUse": [group("Bash", &[guard])]}
    }));
    let ran = f.run("PreToolUse", &bash_call("git pull"));
    assert_eq!(
        ran.json()["hookSpecificOutput"]["updatedInput"],
        json!({"command": "git pull -q"})
    );
}

#[test]
fn each_log_line_names_its_harness() {
    let f = Fixture::new();
    let script = f.handler("deny.sh", &deny_script("no"));
    f.config(json!({"hooks": {"PreToolUse": [group("Bash", &[&script])]}}));
    f.run("PreToolUse", &bash_call("ls"));
    let ran = f.run_as("codex", "PreToolUse", &bash_call("ls"));
    assert_eq!(ran.exit, Some(0));
    assert_eq!(
        ran.json()["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
    let harnesses: Vec<Value> = f.log_lines().iter().map(|l| l["harness"].clone()).collect();
    assert_eq!(harnesses, [json!("claude"), json!("codex")]);
}

#[test]
fn codex_reads_its_own_hooks_and_state_unless_told_otherwise() {
    let f = Fixture::new();
    let (config, state) = (f.dir.join("config"), f.dir.join("state"));
    fs::create_dir_all(config.join("route/codex")).unwrap();
    fs::write(
        config.join("route/hooks.json"),
        json!({"hooks": {}}).to_string(),
    )
    .unwrap();
    let script = f.handler("deny.sh", &deny_script("the codex handler"));
    fs::write(
        config.join("route/codex/hooks.json"),
        json!({"hooks": {"PreToolUse": [group("Bash", &[&script])]}}).to_string(),
    )
    .unwrap();
    let call = |harness: &str| {
        let mut c = Command::new(env!("CARGO_BIN_EXE_route"));
        c.env("XDG_CONFIG_HOME", &config)
            .env("XDG_STATE_HOME", &state)
            .args(["--harness", harness, "PreToolUse"]);
        ran(c, bash_call("ls").to_string().as_bytes())
    };

    let codex = call("codex");
    assert_eq!(
        codex.json()["hookSpecificOutput"]["permissionDecisionReason"],
        "the codex handler"
    );
    // Claude's file lists no handlers, so the same call passes in silence.
    let claude = call("claude");
    assert_eq!((claude.exit, claude.stdout.len()), (Some(0), 0));

    // A switch in Codex's state file turns the handler off for Codex alone.
    fs::create_dir_all(state.join("route/codex")).unwrap();
    fs::write(
        state.join("route/codex/state.json"),
        json!({"disabled": [{"event": "PreToolUse", "matcher": "Bash", "command": script}]})
            .to_string(),
    )
    .unwrap();
    let off = call("codex");
    assert_eq!((off.exit, off.stdout.len()), (Some(0), 0));

    // One shared log, each line naming its harness.
    let harnesses: Vec<Value> = log_lines(&state.join("route/log"))
        .iter()
        .map(|l| l["harness"].clone())
        .collect();
    assert_eq!(harnesses, [json!("codex"), json!("claude"), json!("codex")]);
}

#[test]
fn settings_for_codex_name_the_harness_and_leave_out_on_failure() {
    let f = Fixture::new();
    f.config(json!({"hooks": {"PreToolUse": [group("Bash", &["a"])]}}));
    let out = Command::new(env!("CARGO_BIN_EXE_route"))
        .args(["--harness", "codex", "--config"])
        .arg(f.dir.join("hooks.json"))
        .args(["settings", "--bin", "~/.local/libexec/route"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let block: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        block,
        json!({"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "~/.local/libexec/route --harness codex PreToolUse",
                "timeout": 12}
        ]}]}})
    );
}

#[test]
fn an_unknown_harness_fails_closed_on_pre_tool_use() {
    let f = Fixture::new();
    f.config(json!({"hooks": {}}));
    let ran = ran(
        f.command_as(Some("opencode"), "PreToolUse"),
        bash_call("ls").to_string().as_bytes(),
    );
    assert_eq!(ran.exit, Some(2));
    assert!(
        ran.stderr.contains("unknown harness opencode"),
        "{}",
        ran.stderr
    );
}

#[test]
fn a_codex_bash_call_meets_the_builtin_guards() {
    let f = Fixture::new();
    let guard = "python3 /nonexistent/no-dangerous.py";
    f.config(json!({
        "route": {"builtins": {guard: "no-dangerous"}},
        "hooks": {"PreToolUse": [group("Bash|exec_command|functions.exec_command", &[guard])]}
    }));
    // Codex's payload: Claude Code's fields plus its own turn and model.
    let payload = json!({
        "session_id": "s1",
        "turn_id": "t1",
        "transcript_path": null,
        "cwd": "/tmp",
        "hook_event_name": "PreToolUse",
        "model": "gpt-5.5",
        "permission_mode": "default",
        "tool_name": "Bash",
        "tool_use_id": "call_1",
        "tool_input": {"command": "sudo ls"}
    });
    let ran = f.run_as("codex", "PreToolUse", &payload);
    assert_eq!(
        ran.json()["hookSpecificOutput"]["permissionDecision"],
        "deny"
    );
}
