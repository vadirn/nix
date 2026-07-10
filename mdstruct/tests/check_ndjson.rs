//! CLI-level coverage for `check`'s scoped dangling-anchor channel (plan A5):
//! the `--region` scope filter, the human `warn:` default, and the machine
//! `--format ndjson` records. Drives the compiled binary over stdin so the
//! stream contract (records on stdout, summary on stderr) is exercised end to
//! end. `CARGO_BIN_EXE_mdstruct` is set by Cargo for integration tests.

use std::io::Write;
use std::process::{Command, Stdio};

/// Run `mdstruct check <args...>` with `stdin` as the sole input (`-`).
/// Returns (exit_code, stdout, stderr).
fn run_check(args: &[&str], stdin: &str) -> (i32, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_mdstruct"));
    cmd.arg("check");
    cmd.args(args);
    cmd.arg("-");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().expect("spawn mdstruct");
    child
        .stdin
        .take()
        .expect("stdin piped")
        .write_all(stdin.as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait mdstruct");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8(out.stdout).expect("utf8 stdout"),
        String::from_utf8(out.stderr).expect("utf8 stderr"),
    )
}

/// (a) One unpaired open, scoped to its label with `--format ndjson`, emits
/// exactly one well-formed record carrying `type=unpaired-open`.
#[test]
fn scoped_ndjson_emits_one_unpaired_open_record() {
    let src = "<!-- interact -->\nbody with no close\n";
    let (code, stdout, _stderr) = run_check(&["--region", "interact", "--format", "ndjson"], src);

    assert_eq!(code, 0, "dangling anchors must not change the exit code");

    let lines: Vec<&str> = stdout.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), 1, "exactly one record expected, got: {stdout:?}");

    let rec: serde_json::Value = serde_json::from_str(lines[0]).expect("record is valid JSON");
    assert_eq!(rec["type"], "unpaired-open");
    assert_eq!(rec["label"], "interact");
    assert!(rec["span"]["start"].is_u64(), "span.start is an int");
    assert!(rec["span"]["end"].is_u64(), "span.end is an int");
    assert!(rec["line"].is_u64(), "line is an int");
    assert_eq!(rec["line"], 1);
}

/// (b) Bare `check` (no `--region`) is silent on dangling anchors: nothing on
/// stdout, no `warn:` line on stderr, even with an unpaired open present.
#[test]
fn bare_check_is_silent_on_dangling() {
    let src = "<!-- interact -->\nbody with no close\n";
    let (code, stdout, stderr) = run_check(&[], src);

    assert_eq!(code, 0);
    assert_eq!(stdout, "", "bare check emits nothing on stdout");
    assert!(
        !stderr.contains("warn:"),
        "bare check must not warn on dangling: {stderr:?}"
    );
}

/// (c) An unpaired close under `--region` maps to `type=unpaired-close`.
#[test]
fn scoped_ndjson_maps_unpaired_close() {
    let src = "prose\n\n<!-- /interact -->\n";
    let (code, stdout, _stderr) = run_check(&["--region", "interact", "--format", "ndjson"], src);

    assert_eq!(code, 0);
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), 1, "exactly one record expected, got: {stdout:?}");

    let rec: serde_json::Value = serde_json::from_str(lines[0]).expect("record is valid JSON");
    assert_eq!(rec["type"], "unpaired-close");
    assert_eq!(rec["label"], "interact");
}
