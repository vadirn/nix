//! Golden corpus for the `mdread` CLI.
//!
//! Every address form and flag combination the reader answers to is invoked
//! against a committed fixture, and the three things a caller can observe —
//! stdout, stderr, and the exit code — are recorded in three separate files
//! under `tests/golden/`. Separate files because the contract is not "the
//! output is unchanged" but the sharper "stdout stays byte-identical while
//! stderr may carry a note": a reserved reading served over a live shadow
//! writes to stderr precisely so the payload on stdout is untouched, and a
//! combined recording would hide the distinction the code exists to make.
//!
//! The corpus drives the real binary through `std::process::Command`, not the
//! library API, so clap's own parse errors and the process exit code are
//! inside the contract too.
//!
//! # Regenerating
//!
//! One command re-records every case:
//!
//! ```text
//! UPDATE_GOLDEN=1 cargo test -p mdread --test golden
//! ```
//!
//! In this repo's nix shell:
//!
//! ```text
//! nix-shell --run "CARGO_HOME=\$TMPDIR/cargo UPDATE_GOLDEN=1 cargo test -p mdread --test golden"
//! ```
//!
//! Re-recording rewrites the three files of every case, prunes recordings whose
//! case is gone, and rewrites `tests/golden/MANIFEST.txt`. Read the resulting
//! `git diff` before committing: a corpus is only a net if each change to it
//! was intended.
//!
//! # Machine independence
//!
//! `mdread` prints the file path it was given as the overview's first line and
//! as the `path` field in JSON, so an absolute path would pin the recordings to
//! one checkout. The child process therefore runs with its working directory
//! set to `tests/` and is handed a relative `fixtures/<name>.md`, which is what
//! it echoes back. Nothing else in the output varies by machine: the token
//! counts are computed, and the one OS-supplied string (`No such file or
//! directory (os error 2)`) is identical on Linux and macOS.
//!
//! # Editing fixtures
//!
//! `tests/fixtures/dialects.md` is byte-sensitive: it carries a setext heading
//! and ATX headings indented two and three spaces, which is what makes
//! `--strict-headings` disagree with the default dialect. A Markdown formatter
//! would normalize all three away. Keep it out of any format-on-write path.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

/// One recorded invocation: a file-name stem for its recordings, and the argv
/// that follows the program name.
type Case = (&'static str, &'static [&'static str]);

/// The corpus. Grouped by fixture; every group covers the address forms that
/// fixture can answer, and the flags that change the answer.
const CASES: &[Case] = &[
    // --- rich.md: nested headings, every link kind, frontmatter, a lede ---
    ("rich_overview", &["fixtures/rich.md"]),
    ("rich_overview_json", &["fixtures/rich.md", "--format", "json"]),
    ("rich_overview_wikilinks_only", &["fixtures/rich.md", "--wikilinks-only"]),
    ("rich_overview_strict_headings", &["fixtures/rich.md", "--strict-headings"]),
    ("rich_num_1", &["fixtures/rich.md", "1"]),
    ("rich_num_1_1", &["fixtures/rich.md", "1.1"]),
    ("rich_num_1_1_1", &["fixtures/rich.md", "1.1.1"]),
    ("rich_num_2", &["fixtures/rich.md", "2"]),
    ("rich_slug_background", &["fixtures/rich.md", "background"]),
    ("rich_text_0", &["fixtures/rich.md", "0"]),
    ("rich_text_word", &["fixtures/rich.md", "text"]),
    ("rich_fm", &["fixtures/rich.md", "fm"]),
    ("rich_frontmatter", &["fixtures/rich.md", "frontmatter"]),
    ("rich_fm_uppercase", &["fixtures/rich.md", "FM"]),
    ("rich_links", &["fixtures/rich.md", "links"]),
    ("rich_links_json", &["fixtures/rich.md", "links", "--format", "json"]),
    ("rich_links_wikilinks_only", &["fixtures/rich.md", "links", "--wikilinks-only"]),
    ("rich_num_1_full", &["fixtures/rich.md", "1", "--full"]),
    ("rich_num_1_depth_1", &["fixtures/rich.md", "1", "--depth", "1"]),
    ("rich_num_1_threshold_10", &["fixtures/rich.md", "1", "--threshold", "10"]),
    ("rich_num_1_json", &["fixtures/rich.md", "1", "--format", "json"]),
    ("rich_num_1_full_json", &["fixtures/rich.md", "1", "--full", "--format", "json"]),
    ("rich_err_no_slug", &["fixtures/rich.md", "nope"]),
    ("rich_err_out_of_range", &["fixtures/rich.md", "99"]),
    // --- nested-fm.md: sequences, mappings, a sequence of mappings ---
    ("fmdoc_overview", &["fixtures/nested-fm.md"]),
    ("fmdoc_fm", &["fixtures/nested-fm.md", "fm"]),
    ("fmdoc_fm_json", &["fixtures/nested-fm.md", "fm", "--format", "json"]),
    ("fmdoc_fm_scalar", &["fixtures/nested-fm.md", "fm.title"]),
    ("fmdoc_fm_number", &["fixtures/nested-fm.md", "fm.count"]),
    ("fmdoc_fm_sequence", &["fixtures/nested-fm.md", "fm.tags"]),
    ("fmdoc_fm_sequence_json", &["fixtures/nested-fm.md", "fm.tags", "--format", "json"]),
    ("fmdoc_fm_mapping", &["fixtures/nested-fm.md", "fm.meta"]),
    ("fmdoc_fm_seq_of_maps", &["fixtures/nested-fm.md", "fm.references"]),
    ("fmdoc_fm_indexed", &["fixtures/nested-fm.md", "fm.references[0].target"]),
    ("fmdoc_frontmatter_dot_path", &["fixtures/nested-fm.md", "frontmatter.meta.author"]),
    ("fmdoc_err_missing_key", &["fixtures/nested-fm.md", "fm.nope"]),
    ("fmdoc_err_index_out_of_range", &["fixtures/nested-fm.md", "fm.tags[9]"]),
    // --- no-frontmatter.md ---
    ("plain_overview", &["fixtures/no-frontmatter.md"]),
    ("plain_text", &["fixtures/no-frontmatter.md", "text"]),
    ("plain_links", &["fixtures/no-frontmatter.md", "links"]),
    ("plain_err_fm", &["fixtures/no-frontmatter.md", "fm"]),
    // --- no-lede.md ---
    ("nolede_overview", &["fixtures/no-lede.md"]),
    ("nolede_fm", &["fixtures/no-lede.md", "fm"]),
    ("nolede_links", &["fixtures/no-lede.md", "links"]),
    ("nolede_err_text", &["fixtures/no-lede.md", "text"]),
    ("nolede_err_0", &["fixtures/no-lede.md", "0"]),
    // --- collisions.md: headings slugging to Links, FM, Frontmatter, Text,
    //     in a file with neither a frontmatter block nor a lede, so the
    //     reserved addresses fail with a shadow clause ---
    ("collide_overview", &["fixtures/collisions.md"]),
    ("collide_overview_json", &["fixtures/collisions.md", "--format", "json"]),
    ("collide_links", &["fixtures/collisions.md", "links"]),
    ("collide_links_json", &["fixtures/collisions.md", "links", "--format", "json"]),
    ("collide_num_1_1", &["fixtures/collisions.md", "1.1"]),
    ("collide_err_fm", &["fixtures/collisions.md", "fm"]),
    ("collide_err_text", &["fixtures/collisions.md", "text"]),
    ("collide_err_0", &["fixtures/collisions.md", "0"]),
    // --- collisions-live.md: the same collisions over readings that succeed,
    //     so the note lands on stderr and stdout carries the payload ---
    ("live_overview", &["fixtures/collisions-live.md"]),
    ("live_fm", &["fixtures/collisions-live.md", "fm"]),
    ("live_fm_json", &["fixtures/collisions-live.md", "fm", "--format", "json"]),
    ("live_text", &["fixtures/collisions-live.md", "text"]),
    ("live_0", &["fixtures/collisions-live.md", "0"]),
    ("live_links", &["fixtures/collisions-live.md", "links"]),
    // --- dialects.md: setext and indented ATX headings, which the two
    //     heading rules disagree about ---
    ("dialect_overview", &["fixtures/dialects.md"]),
    ("dialect_overview_strict", &["fixtures/dialects.md", "--strict-headings"]),
    ("dialect_num_1", &["fixtures/dialects.md", "1"]),
    ("dialect_num_1_strict", &["fixtures/dialects.md", "1", "--strict-headings"]),
    ("dialect_text_strict", &["fixtures/dialects.md", "text", "--strict-headings"]),
    ("dialect_err_text", &["fixtures/dialects.md", "text"]),
    // --- the CLI surface itself, clap's parse errors included ---
    ("cli_err_missing_file", &["fixtures/does-not-exist.md"]),
    ("cli_err_bad_format", &["fixtures/rich.md", "--format", "yaml"]),
    ("cli_err_bad_depth", &["fixtures/rich.md", "1", "--depth", "abc"]),
    ("cli_err_unknown_flag", &["fixtures/rich.md", "--nope"]),
    ("cli_err_no_args", &[]),
];

/// The three observable streams, in the order they are recorded.
const STREAMS: [&str; 3] = ["stdout", "stderr", "exit"];

/// Case name to invocation, so a recording on disk says what produced it
/// without a reader opening this file.
const MANIFEST: &str = "MANIFEST.txt";

fn tests_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

fn golden_dir() -> PathBuf {
    tests_dir().join("golden")
}

/// Run the real binary and return its three streams, the exit code rendered as
/// its own one-line recording.
fn invoke(args: &[&str]) -> (String, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_mdread"))
        .args(args)
        // The child echoes the path it was given, so hand it a relative one
        // from a fixed working directory: the recording is then the same on
        // every machine and every checkout.
        .current_dir(tests_dir())
        // clap already drops color when stdout is a pipe; say so explicitly in
        // case the ambient environment forces it back on.
        .env("NO_COLOR", "1")
        .env_remove("CLICOLOR_FORCE")
        .output()
        .unwrap_or_else(|e| panic!("could not run mdread {}: {e}", args.join(" ")));
    let code = match out.status.code() {
        Some(c) => c.to_string(),
        // Killed by a signal: no code to record, and the mismatch says so.
        None => "signal".to_string(),
    };
    (
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        format!("{code}\n"),
    )
}

/// The fixture an invocation reads, for the failure report.
fn fixture_of<'a>(args: &[&'a str]) -> &'a str {
    args.iter()
        .copied()
        .find(|a| a.ends_with(".md"))
        .unwrap_or("(no file)")
}

/// A line-oriented diff of the divergent span with three lines of context on
/// each side. Split on `\n` rather than by `lines()` so a difference in the
/// trailing newline shows up as a trailing empty line rather than vanishing.
fn diff(expected: &str, actual: &str) -> String {
    const CONTEXT: usize = 3;
    const MAX: usize = 40;

    let e: Vec<&str> = expected.split('\n').collect();
    let a: Vec<&str> = actual.split('\n').collect();

    let mut head = 0;
    while head < e.len() && head < a.len() && e[head] == a[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < e.len() - head
        && tail < a.len() - head
        && e[e.len() - 1 - tail] == a[a.len() - 1 - tail]
    {
        tail += 1;
    }

    let mut out = String::new();
    let lead = head.saturating_sub(CONTEXT);
    for (i, line) in e[lead..head].iter().enumerate() {
        out.push_str(&format!("       {:>4} {line}\n", lead + i + 1));
    }
    let mut side = |mark: char, lines: &[&str], from: usize| {
        for (i, line) in lines.iter().enumerate().take(MAX) {
            out.push_str(&format!("     {mark} {:>4} {line}\n", from + i + 1));
        }
        if lines.len() > MAX {
            out.push_str(&format!("     {mark} .... ({} more lines)\n", lines.len() - MAX));
        }
    };
    side('-', &e[head..e.len() - tail], head);
    side('+', &a[head..a.len() - tail], head);
    let trail_from = e.len() - tail;
    let mut trail = &e[trail_from..];
    // The final element of a `\n`-split recording is the empty string after the
    // last newline. It is not a line, so it is context worth nothing.
    if trail.last() == Some(&"") {
        trail = &trail[..trail.len() - 1];
    }
    for (i, line) in trail.iter().take(CONTEXT).enumerate() {
        out.push_str(&format!("       {:>4} {line}\n", trail_from + i + 1));
    }
    out
}

/// One divergence, named well enough to act on without opening this file.
fn report(name: &str, args: &[&str], stream: &str, expected: &str, actual: &str) -> String {
    format!(
        "case '{name}': stream {stream} diverged\n  \
         fixture:    {}\n  \
         invocation: mdread {}\n  \
         recording:  mdread/tests/golden/{name}.{stream}\n  \
         size:       expected {} bytes, actual {} bytes\n{}",
        fixture_of(args),
        args.join(" "),
        expected.len(),
        actual.len(),
        diff(expected, actual)
    )
}

#[test]
fn golden_corpus() {
    let update = std::env::var_os("UPDATE_GOLDEN").is_some();
    let dir = golden_dir();
    if update {
        std::fs::create_dir_all(&dir).expect("could not create tests/golden");
    }

    // A duplicated stem would silently record one case over another.
    let mut names = BTreeSet::new();
    for (name, _) in CASES {
        assert!(names.insert(*name), "duplicate case name '{name}'");
    }

    let mut wanted: BTreeSet<String> = BTreeSet::new();
    wanted.insert(MANIFEST.to_string());
    let mut manifest = String::new();
    let mut failures: Vec<String> = Vec::new();

    for (name, args) in CASES {
        manifest.push_str(&format!("{name}\tmdread {}\n", args.join(" ")));
        let (stdout, stderr, exit) = invoke(args);
        for (stream, actual) in STREAMS.iter().zip([&stdout, &stderr, &exit]) {
            let file = format!("{name}.{stream}");
            wanted.insert(file.clone());
            let path = dir.join(&file);
            if update {
                std::fs::write(&path, actual)
                    .unwrap_or_else(|e| panic!("could not write {}: {e}", path.display()));
                continue;
            }
            match std::fs::read_to_string(&path) {
                Ok(expected) if expected == **actual => {}
                Ok(expected) => failures.push(report(name, args, stream, &expected, actual)),
                Err(e) => failures.push(format!(
                    "case '{name}': no recording for stream {stream}\n  \
                     invocation: mdread {}\n  \
                     recording:  mdread/tests/golden/{file} ({e})\n{}",
                    args.join(" "),
                    diff("", actual)
                )),
            }
        }
    }

    // The manifest is derived from the case table, so a stale one means the
    // table moved without a re-record.
    let manifest_path = dir.join(MANIFEST);
    if update {
        std::fs::write(&manifest_path, &manifest).expect("could not write MANIFEST.txt");
    } else {
        match std::fs::read_to_string(&manifest_path) {
            Ok(on_disk) if on_disk == manifest => {}
            Ok(on_disk) => failures.push(format!(
                "the manifest no longer matches the case table\n  \
                 recording:  mdread/tests/golden/{MANIFEST}\n{}",
                diff(&on_disk, &manifest)
            )),
            Err(e) => failures.push(format!("could not read {MANIFEST}: {e}")),
        }
    }

    // Recordings left behind by a case that was renamed or removed. They would
    // otherwise sit in the tree looking authoritative.
    let mut orphans: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if wanted.contains(&file) {
                continue;
            }
            if update {
                let _ = std::fs::remove_file(entry.path());
            } else {
                orphans.push(file);
            }
        }
    }
    if !orphans.is_empty() {
        orphans.sort();
        failures.push(format!(
            "recordings with no case in the table: {}",
            orphans.join(", ")
        ));
    }

    assert!(
        failures.is_empty(),
        "{} golden mismatch(es) across {} cases.\n\
         Confirm every change below is intended, then re-record with:\n  \
         UPDATE_GOLDEN=1 cargo test -p mdread --test golden\n\n{}",
        failures.len(),
        CASES.len(),
        failures.join("\n")
    );
}
