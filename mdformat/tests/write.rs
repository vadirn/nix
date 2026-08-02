//! CLI-level coverage for `format --write`: the crate's only file-writing path.
//!
//! Drives the compiled binary, because the thing under test is not a function's
//! return value — it is what is on disk afterwards, and what a person reading
//! stderr is told about it. `CARGO_BIN_EXE_mdformat` is set by Cargo for
//! integration tests.
//!
//! Three claims are asserted here and nowhere else:
//!
//! 1. **The gate.** Exactly one named regular file is accepted. Two paths (which
//!    is what a shell glob looks like from inside the process), a directory, and
//!    stdin are refused, before any byte is read, with a message that names the
//!    gate — so the tier boundary is enforced by this program rather than by the
//!    person running it.
//! 2. **The reporting.** Every rule declination and every construct left
//!    verbatim is printed unasked, because the rewritten bytes do not show what
//!    was left alone and the person inspecting them is the reason this tier is
//!    allowed. There is no flag to ask with: `--verbose` gated exactly that
//!    report elsewhere in the CLI and is gone, which a test here pins.
//! 3. **Nothing is written unless everything held.** An `Err` from a rule, and
//!    an already-normal document, both leave the file byte-identical — the
//!    second without even moving its mtime.
//!
//! Every fixture lives in a fresh directory under `TMPDIR`; no test here reads
//! or writes anything outside it. Specimens are byte literals so no escape in
//! this file can be mistaken for a markdown escape in the document.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Run `mdformat format <args...>`. Returns (exit code, stdout, stderr).
fn run(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_mdformat"))
        .arg("format")
        .args(args)
        .output()
        .expect("spawn mdformat");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8(out.stdout).expect("utf8 stdout"),
        String::from_utf8(out.stderr).expect("utf8 stderr"),
    )
}

/// A fresh empty directory under `TMPDIR`, named after the calling test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mdformat-cli-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

fn file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, bytes).expect("write fixture");
    p
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A document that (a) changes — its table is unpadded — and (b) holds two
/// constructs the marker rule declines, because unifying the two adjacent
/// bullets would merge them into one list.
const DECLINING: &[u8] = b"# Title\n\n- alpha\n\n* beta\n\n| x | yy |\n| - | - |\n| 1 | 2 |\n";

/// A UTF-8 byte order mark followed immediately by a multi-row table, unpadded.
/// This was the specimen `an_erroring_document_is_left_alone` was written
/// against: comrak carried the mark's three bytes onto every body row, the last
/// cell's span ran past the end of the file, and `format` returned `Err`.
/// `mdformat::parse_with` repairs that now, so the same bytes are a document
/// this tier **rewrites** — which is what the test below asserts, at the only
/// place the whole path from argument to disk is visible.
const MARKED: &[u8] = b"\xef\xbb\xbf| a | b |\n| --- | --- |\n| 1 | 2 |\n";

/// A three-space-indented table whose last row is a lazy continuation carrying
/// no indent. comrak gives every row the table's opening offset on line 1 — the
/// indent included — so `para`'s cells are reported three columns right of where
/// they are, and their spans run past the end of the file. `format` returns
/// `Err`, which under this tier is a refusal a person reads.
///
/// This is the same *mechanism* the mark once triggered and a different cause:
/// an offset a container contributes on line 1 is assumed to repeat on every
/// line the container spans, and an indent a lazy row omits breaks that
/// assumption exactly as a mark does. Only the mark is repaired, because only
/// the mark's carry is a fixed width knowable without re-deriving each row's
/// indent from the source. Holding this shape as an asserted refusal is what
/// keeps that boundary visible: the day it starts formatting, this test fails
/// and someone has to say what changed.
const ERRS: &[u8] = b"   |a|b|\n   |-|-|\n   |1|2|\npara\n";

/// (1) The happy path: one named file is rewritten in place, stdout stays
/// empty, and the file on disk holds the formatted bytes.
#[test]
fn one_named_file_is_rewritten_in_place() {
    let dir = scratch("happy");
    let p = file(&dir, "note.md", DECLINING);

    let (code, stdout, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout, "", "--write puts bytes in the file, not on stdout");
    let after = fs::read(&p).expect("read back");
    assert_ne!(after, DECLINING, "the file must have changed");
    assert!(
        String::from_utf8(after.clone())
            .expect("utf8")
            .contains("| x   | yy |"),
        "the table must be padded: {}",
        String::from_utf8_lossy(&after)
    );
    assert!(stderr.contains("rewritten in place"), "{stderr}");
    assert!(stderr.contains("1/1 files rewritten"), "{stderr}");
}

/// The rewritten file is what `--check` calls normal. Stated separately from
/// the happy path because it is the property that makes the rewrite worth
/// making, not an incidental of it.
#[test]
fn what_is_written_is_in_normal_form() {
    let dir = scratch("normal");
    let p = file(&dir, "note.md", DECLINING);

    assert_eq!(run(&["--write", &s(&p)]).0, 0);
    let (code, _, stderr) = run(&["--check", &s(&p)]);
    assert_eq!(code, 0, "the rewritten file must be normal: {stderr}");
}

/// (2) Every declination is reported without being asked for, naming the rule,
/// the line, and the reason — that reporting is the point of this tier.
#[test]
fn every_declination_is_reported_without_being_asked() {
    let dir = scratch("report");
    let p = file(&dir, "note.md", DECLINING);

    let (code, _, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    let exempt: Vec<&str> = stderr.lines().filter(|l| l.contains("EXEMPT")).collect();
    assert_eq!(
        exempt.len(),
        2,
        "both declined lists must be named: {stderr}"
    );
    assert!(exempt.iter().all(|l| l.contains("markers")), "{stderr}");
    assert!(exempt.iter().any(|l| l.contains("L3")), "{stderr}");
    assert!(exempt.iter().any(|l| l.contains("L5")), "{stderr}");
    assert!(
        exempt.iter().all(|l| l.contains("would merge them")),
        "each exemption must carry its reason: {stderr}"
    );
    assert!(stderr.contains("2 exempt constructs"), "{stderr}");
}

/// An exemption's line number addresses the **rewritten** file, not the file as
/// it was — which is what makes the report usable by the person about to open
/// it. Held with a specimen whose gap normalization moves both declined lists
/// two lines up: a report in the old coordinates would say L5 and L7.
#[test]
fn an_exemption_names_a_line_in_the_file_as_written() {
    let dir = scratch("coords");
    let p = file(&dir, "note.md", b"# Title\n\n\n\n- alpha\n\n* beta\n");

    let (code, _, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    let after = String::from_utf8(fs::read(&p).expect("read back")).expect("utf8");
    let lines: Vec<&str> = after.lines().collect();
    assert_eq!(lines[2], "- alpha", "{after:?}");
    assert_eq!(lines[4], "* beta", "{after:?}");
    assert!(stderr.contains("EXEMPT: L3: markers"), "{stderr}");
    assert!(stderr.contains("EXEMPT: L5: markers"), "{stderr}");
}

/// There is no `--verbose` to ask with any more, under `--write` or anywhere
/// else. It only ever gated the report the test above asserts is already
/// unconditional here, so removing it took nothing away — and an invocation
/// carrying it is refused rather than quietly accepted, so a caller still
/// passing it learns the report it wanted is the one it is getting.
#[test]
fn verbose_is_gone_from_the_surface() {
    let dir = scratch("verbose");
    let p = file(&dir, "note.md", DECLINING);

    let (code, stdout, stderr) = run(&["--write", "--verbose", &s(&p)]);

    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stdout, "");
    assert!(
        stderr.contains("unexpected argument '--verbose'"),
        "{stderr}"
    );
    assert_eq!(
        fs::read(&p).expect("read back"),
        DECLINING,
        "a refused invocation writes nothing"
    );
}

/// (3) The gate: two paths is what a shell glob looks like from in here, and it
/// is refused rather than looped over. Neither file is touched.
#[test]
fn two_paths_are_refused_and_neither_file_is_touched() {
    let dir = scratch("two");
    let a = file(&dir, "a.md", DECLINING);
    let b = file(&dir, "b.md", DECLINING);

    let (code, stdout, stderr) = run(&["--write", &s(&a), &s(&b)]);

    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stdout, "");
    assert!(stderr.contains("exactly one file path"), "{stderr}");
    assert!(
        stderr.contains("separate tier this binary does not implement"),
        "the refusal must name the gate: {stderr}"
    );
    assert_eq!(fs::read(&a).expect("read a"), DECLINING);
    assert_eq!(fs::read(&b).expect("read b"), DECLINING);
}

/// A directory is the shape a batch arrives in. It is refused, and the file
/// inside it is not walked to.
#[test]
fn a_directory_is_refused_and_its_contents_are_not_walked() {
    let dir = scratch("dir");
    let inside = file(&dir, "inside.md", DECLINING);

    let (code, stdout, stderr) = run(&["--write", &s(&dir)]);

    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stdout, "");
    assert!(stderr.contains("one regular file"), "{stderr}");
    assert!(
        stderr.contains("separate tier this binary does not implement"),
        "{stderr}"
    );
    assert_eq!(fs::read(&inside).expect("read inside"), DECLINING);
}

/// A bare `--write` is refused rather than defaulted to stdin the way every
/// reporting verb defaults it — the target has to be a path a person typed.
#[test]
fn a_bare_write_is_refused_rather_than_reading_stdin() {
    let (code, stdout, stderr) = run(&["--write"]);
    assert_eq!(code, 2, "{stderr}");
    assert_eq!(stdout, "");
    assert!(
        stderr.contains("exactly one file path and got 0"),
        "{stderr}"
    );
}

#[test]
fn stdin_is_refused_because_it_names_no_file() {
    let (code, _, stderr) = run(&["--write", "-"]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("no stdin input"), "{stderr}");
}

#[test]
fn write_and_check_together_are_refused() {
    let dir = scratch("both");
    let p = file(&dir, "note.md", DECLINING);

    let (code, _, stderr) = run(&["--write", "--check", &s(&p)]);

    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("give one or the other"), "{stderr}");
    assert_eq!(fs::read(&p).expect("read back"), DECLINING);
}

#[test]
fn a_missing_file_is_refused_before_anything_is_read() {
    let dir = scratch("missing");
    let (code, _, stderr) = run(&["--write", &s(&dir.join("absent.md"))]);
    assert_eq!(code, 2, "{stderr}");
    assert!(stderr.contains("--write cannot read"), "{stderr}");
}

/// (4) A rule that errors writes nothing. The specimen is a document comrak
/// still mis-positions (see [`ERRS`]), which is exactly the case this tier is
/// meant to surface to a person rather than paper over.
#[test]
fn an_erroring_document_is_left_alone() {
    let dir = scratch("err");
    let p = file(&dir, "note.md", ERRS);
    let before = fs::metadata(&p).expect("stat").modified().expect("mtime");

    let (code, stdout, stderr) = run(&["--write", &s(&p)]);

    assert_ne!(code, 0, "an erroring document must exit non-zero");
    assert_eq!(code, 5, "{stderr}");
    assert_eq!(stdout, "");
    assert!(stderr.contains("SOURCEPOS ERROR"), "{stderr}");
    assert!(stderr.contains("NOT REWRITTEN"), "{stderr}");
    assert_eq!(fs::read(&p).expect("read back"), ERRS, "bytes must survive");
    assert_eq!(
        fs::metadata(&p).expect("stat").modified().expect("mtime"),
        before,
        "an untouched file must keep its mtime"
    );
}

/// The regression this file used to assert the other way round. A byte order
/// mark in front of a multi-row table exited 5 and wrote nothing; it now goes
/// all the way to disk, padded, with the mark still the file's first three
/// bytes. Asserted here as well as in `tests/normal_form.rs` because only this
/// tier can show the bytes reaching a file rather than a return value — and
/// because the mark is precisely the kind of byte a rewrite could drop without
/// any in-process assertion noticing.
#[test]
fn a_byte_order_marked_table_is_rewritten_in_place() {
    let dir = scratch("marked");
    let p = file(&dir, "note.md", MARKED);

    let (code, stdout, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout, "");
    assert!(
        !stderr.contains("SOURCEPOS ERROR"),
        "the mark must no longer defeat the sourcepos conversion: {stderr}"
    );
    assert_eq!(
        fs::read(&p).expect("read back"),
        b"\xef\xbb\xbf| a   | b |\n| --- | --- |\n| 1   | 2 |\n",
        "the table must be padded and the mark must survive as the first bytes"
    );
    assert!(stderr.contains("1/1 files rewritten"), "{stderr}");

    // And the rewrite is a fixpoint, mark and all.
    let (code, _, stderr) = run(&["--check", &s(&p)]);
    assert_eq!(code, 0, "the rewritten file must be normal: {stderr}");
}

/// (5) The no-op: a document already in normal form is not rewritten with
/// identical bytes, so its mtime does not move and nothing downstream sees a
/// change that is not one.
#[test]
fn an_already_normal_document_is_not_rewritten() {
    let dir = scratch("noop");
    let normal = b"# Title\n\nA paragraph.\n\n- alpha\n- beta\n";
    let p = file(&dir, "note.md", normal);
    let before = fs::metadata(&p).expect("stat").modified().expect("mtime");

    let (code, stdout, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout, "");
    assert!(stderr.contains("already in normal form"), "{stderr}");
    assert!(stderr.contains("0/1 files rewritten"), "{stderr}");
    assert_eq!(fs::read(&p).expect("read back"), normal);
    assert_eq!(
        fs::metadata(&p).expect("stat").modified().expect("mtime"),
        before,
        "an unwritten file must keep its mtime"
    );
}

/// The replacement is a rename, end to end: the run leaves no temp file beside
/// the target, and the target's inode has changed — which is what proves the
/// original was never opened for writing.
#[test]
fn the_replacement_is_atomic_end_to_end() {
    use std::os::unix::fs::MetadataExt;
    let dir = scratch("atomic");
    let p = file(&dir, "note.md", DECLINING);
    let before = fs::metadata(&p).expect("stat").ino();

    let (code, _, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    assert_ne!(
        fs::metadata(&p).expect("stat").ino(),
        before,
        "the rewritten name must point at a new inode"
    );
    let entries: Vec<_> = fs::read_dir(&dir)
        .expect("read dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["note.md".to_string()], "{entries:?}");
}

/// The mode the file carried is the mode it carries afterwards, through the
/// real CLI and not just through `write::replace`.
#[test]
fn the_permission_bits_survive_the_cli_write() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("perms");
    let p = file(&dir, "note.md", DECLINING);
    fs::set_permissions(&p, fs::Permissions::from_mode(0o640)).expect("chmod");

    let (code, _, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    let mode = fs::metadata(&p).expect("stat").permissions().mode() & 0o777;
    assert_eq!(mode, 0o640, "got {mode:o}");
}

/// Rewriting twice is rewriting once: the second run finds the file normal and
/// leaves it alone. The retraction, observed through the write path.
#[test]
fn a_second_write_finds_nothing_to_do() {
    let dir = scratch("twice");
    let p = file(&dir, "note.md", DECLINING);

    assert_eq!(run(&["--write", &s(&p)]).0, 0);
    let once = fs::read(&p).expect("read back");

    let (code, _, stderr) = run(&["--write", &s(&p)]);
    assert_eq!(code, 0, "{stderr}");
    assert!(stderr.contains("already in normal form"), "{stderr}");
    assert_eq!(fs::read(&p).expect("read back"), once);
}

/// Without `--write` nothing on disk moves, which is the property every other
/// verb here has always had and must keep.
#[test]
fn the_default_format_verb_still_writes_no_file() {
    let dir = scratch("stdout");
    let p = file(&dir, "note.md", DECLINING);

    let (code, stdout, stderr) = run(&[&s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    assert!(!stdout.is_empty(), "the formatted bytes go to stdout");
    assert_eq!(fs::read(&p).expect("read back"), DECLINING);
}
