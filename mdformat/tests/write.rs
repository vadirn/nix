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
//! 3. **Nothing is written unless everything held.** An `Err` from a rule and
//!    an already-normal document both leave the file byte-identical, and
//!    neither moves its mtime.
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
/// The **first** of the two specimens this file has lost to a repair — see
/// [`ERRS`], which is the third to carry claim 3 and the first still standing:
/// comrak anchored every body row at the table's line-1
/// opening offset — the mark's three bytes included — so the last cell's span
/// ran past the end of the file and `format` returned `Err`.
/// [`mdformat::anchor`] re-anchors each row at its own line's opening now, so
/// the same bytes are a document this tier **rewrites** — which is what the test
/// below asserts, at the only place the whole path from argument to disk is
/// visible.
const MARKED: &[u8] = b"\xef\xbb\xbf| a | b |\n| --- | --- |\n| 1 | 2 |\n";

/// A three-space-indented table whose last row is a lazy continuation carrying
/// no indent: the **second** specimen lost to a repair, and the same defect as
/// [`MARKED`] wearing an indent instead of a mark. comrak gave every row the
/// table's line-1 opening offset, so `para`'s
/// cells were reported three columns right of where they are and ran past the
/// end of the file.
///
/// The pair is why the repair is keyed on each row's own opening rather than on
/// the mark: a mark is three bytes wide and an indent is any width, so no
/// constant could have covered both. This tier is where that is worth restating,
/// because a document it once refused is a document it now writes to disk. The
/// library-level fixtures are `tests/partition.rs`'s `table-indented-lazy-row`
/// and `mdformat::anchor`'s `every_cell_resolves_to_its_own_bytes`.
const LAZY: &[u8] = b"   |a|b|\n   |-|-|\n   |1|2|\npara\n";

/// The document claim 3 is asserted against today. Three conditions hold at
/// once, and `the_erroring_specimen_needs_all_three_conditions` below pins each
/// one by removing it:
///
/// 1. a row supplies **fewer cells than the header**, so comrak autocompletes
///    the missing one;
/// 2. that row **does not end in a pipe**, so the autocompleted cell is placed
///    on the delimiter that would have followed the row's last cell rather than
///    on a delimiter that is there;
/// 3. that row is the file's **last line and the file has no line ending**, so
///    the byte the cell was placed on does not exist.
///
/// The cell's span therefore resolves one byte past the end of the source and
/// `format` returns `Err`, which under this tier is a refusal a person reads.
///
/// This is a **different** comrak defect from the one [`MARKED`] and [`LAZY`]
/// carried, and it survives that repair untouched: every line here opens at
/// column 1, so `mdformat::anchor` is the identity on this document.
///
/// **If this document starts formatting, do not weaken the assertions below.**
/// The claim they make is about the write path, not about comrak, and the
/// specimen is only its carrier — the third carrier so far. Find a fourth the
/// way this one was found: run `format` over generated documents built from a
/// line alphabet and keep one that exits 5. The two carriers it replaced are
/// still in this file, as [`MARKED`] and [`LAZY`], now asserted as documents
/// that go all the way to disk.
const ERRS: &[u8] = b"| a | b |\n| --- | --- |\n| 1 | 2 |\npara";

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

/// (4) A rule that errors writes nothing.
///
/// The specimen is a document comrak still mis-positions — [`ERRS`], whose own
/// comment states the three conditions that make it one — which is exactly the
/// case this tier is meant to surface to a person rather than paper over. Of the
/// two
/// routes open to this test when its previous specimen was repaired, this is the
/// one taken: **a live erroring document**, kept because it is the only route
/// that exercises the whole path from a typed argument to the bytes on disk. The
/// alternative — a synthetic `Err` injected at an internal boundary — is out of
/// reach from an integration test, which sees only the crate's public API and
/// the compiled binary, and would in any case prove the reporting without
/// proving that the file was never opened.
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

/// Each of [`ERRS`]'s three conditions is key, held by removing one at
/// a time and watching the refusal go away.
///
/// This asserts nothing about the write path; it is the maintenance contract for
/// the specimen the test above depends on. Two documents have already stopped
/// erroring under this file's feet, and each time the question that cost the
/// most was *which* property had changed. Here the answer arrives as the name of
/// whichever control flipped: a repair aimed at the autocompleted cell reddens
/// the specimen alone, and a repair that widened further would redden a control
/// too. The plain `format` verb is enough — the refusal is decided before
/// anything is written, so `--write` would add a file operation and no
/// information.
#[test]
fn the_erroring_specimen_needs_all_three_conditions() {
    let dir = scratch("conditions");
    // (name, document, expected exit code). Each control drops exactly one
    // condition from `ERRS` and must format.
    let cases: &[(&str, &[u8], i32)] = &[
        ("the specimen", ERRS, 5),
        // 3 dropped: the file ends in a line ending, which is a byte the
        // autocompleted cell can land on.
        (
            "with a final line ending",
            b"| a | b |\n| --- | --- |\n| 1 | 2 |\npara\n",
            0,
        ),
        // 1 dropped: a square row needs no autocompleted cell at all.
        (
            "with a square last row",
            b"| a | b |\n| --- | --- |\n| 1 | 2 |\n| p | q |",
            0,
        ),
        // 2 dropped: still one cell short, but the row's closing pipe is a byte
        // the autocompleted cell can be placed on.
        (
            "with a closing pipe on the short row",
            b"| a | b |\n| --- | --- |\n| 1 | 2 |\n| p |",
            0,
        ),
    ];
    for (name, doc, want) in cases {
        let p = file(&dir, &format!("{}.md", name.replace(' ', "-")), doc);
        let (code, _, stderr) = run(&[&s(&p)]);
        assert_eq!(code, *want, "{name}: {stderr}");
        assert_eq!(
            stderr.contains("SOURCEPOS ERROR"),
            *want == 5,
            "{name}: {stderr}"
        );
    }
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

/// The same regression asserted the other way round for the second specimen
/// this file lost: an indented table with a lazy continuation row ([`LAZY`])
/// exited 5 under every verb, and now exits 0 under all three.
///
/// It is a *declination* rather than a rewrite, and that is the point of
/// asserting it here rather than only in `tests/partition.rs`. The lazy row is
/// one cell short of its header, so the tables rule leaves the table verbatim
/// and says so — and only under this tier is that sentence the product. A person
/// gets a named exemption where they used to get a refusal, and the file is
/// untouched for a stated reason instead of an unreadable one.
#[test]
fn an_indented_table_with_a_lazy_row_is_reported_rather_than_refused() {
    let dir = scratch("lazy");
    let p = file(&dir, "note.md", LAZY);

    let (code, stdout, stderr) = run(&["--write", &s(&p)]);

    assert_eq!(code, 0, "{stderr}");
    assert_eq!(stdout, "");
    assert!(
        !stderr.contains("SOURCEPOS ERROR"),
        "the omitted indent must no longer defeat the sourcepos conversion: {stderr}"
    );
    assert!(stderr.contains("EXEMPT"), "{stderr}");
    assert!(stderr.contains("tables"), "{stderr}");
    assert_eq!(
        fs::read(&p).expect("read back"),
        LAZY,
        "an exempt table leaves the document byte-identical"
    );
    assert!(stderr.contains("0/1 files rewritten"), "{stderr}");

    // The second of the three verbs the refusal used to reach. The third,
    // `partition`, is covered by `tests/partition.rs`'s `table-indented-lazy-row`
    // fixture, which this file's `run` helper cannot reach — it prepends
    // `format` to every invocation on purpose.
    let (code, _, stderr) = run(&["--check", &s(&p)]);
    assert_eq!(code, 0, "--check must agree it is normal: {stderr}");
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
