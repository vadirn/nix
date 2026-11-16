//! Port of `no-secrets.sh`: a tripwire against accidental secret reads
//! landing in context (`cat .env`, `head id_rsa`). Not a security boundary;
//! the real enforcement is `sandbox.credentials` in settings.json.
//!
//! Denies when the command runs a reader and names a sensitive file. The
//! script matched both with regexes over the raw text. Here a reader is a
//! word whose last path component is a reader's name, and the file pattern
//! runs over each word's value, lowercased, in every simple command, so a
//! reader named inside a quoted message no longer counts as a reader.
//!
//! A search's pattern and jq's filter are not files, so they are left out:
//! `rg 'process\.env' src` reads no `.env`, while `rg KEY .env` and
//! `rg -f .env src` do. The script matched the pattern like any other word.

use std::sync::LazyLock;

use regex::Regex;

use super::{Ctx, Verdict, first_deny};
use crate::shell::{Script, Segment};

const REASON: &str = "Blocked: command reads from a sensitive file (.env, credentials, keys). Use the Read tool instead — it has its own deny rules.";

const READERS: &[&str] = &[
    "cat", "head", "tail", "less", "more", "grep", "rg", "egrep", "fgrep", "ag", "ack", "sed",
    "awk", "jq", "yq", "bat", "base64", "xxd", "od", "strings", "nl", "tac", "tee", "source",
];

/// The script's file pattern, unchanged: tokens anchored to a path boundary,
/// so a leading-dot accessor (`jq '.data.key'`) never reads as a filename.
static SENSITIVE: LazyLock<Regex> = LazyLock::new(|| {
    let ext = "(json|ya?ml|ini|cfg|conf|toml|properties|txt|csv|xml|enc|b64|bak)";
    let pattern = [
        r"(\.env($|[^[:alnum:]_])".to_string(),
        r"|[/-]credentials($|[^[:alnum:]_./-])".to_string(),
        format!(r"|(^|[^[:alnum:]_.])credentials\.{ext}($|[^[:alnum:]])"),
        r"|/secrets?($|[^[:alnum:]_.-])".to_string(),
        format!(r"|(^|[^[:alnum:]_.])secrets?\.{ext}($|[^[:alnum:]])"),
        r"|(^|[^[:alnum:]_.])[[:alnum:]_~][^[:space:]]*\.(pem|key|p12|pfx|keystore)($|[^[:alnum:]])"
            .to_string(),
        r"|id_rsa|id_ed25519|token\.json|auth\.json|\.netrc|\.npmrc|\.pypirc)".to_string(),
    ]
    .concat();
    Regex::new(&pattern).expect("the sensitive-file pattern compiles")
});

pub fn check(ctx: &Ctx) -> Verdict {
    first_deny(&ctx.scripts(), |s| {
        (reads(s) && names_sensitive(s)).then(|| REASON.to_string())
    })
}

fn reads(s: &Script) -> bool {
    s.segments.iter().any(|seg| {
        seg.words.iter().enumerate().any(|(k, w)| {
            let base = w.base();
            READERS.contains(&base)
                || base == "xargs"
                || (base == "find"
                    && seg.words[k + 1..]
                        .iter()
                        .any(|a| a.value.starts_with("-exec")))
        })
    })
}

fn names_sensitive(s: &Script) -> bool {
    s.segments.iter().any(|seg| {
        let skip = pattern_words(seg);
        seg.words
            .iter()
            .enumerate()
            .filter(|(k, _)| !skip.contains(k))
            .map(|(_, w)| w)
            .chain(&seg.assigns)
            .chain(seg.redirects.iter().filter_map(|r| r.target.as_ref()))
            .any(|w| SENSITIVE.is_match(&w.value.to_ascii_lowercase()))
    })
}

/// How a tool whose first operand is a pattern or program reads its words.
struct Roles {
    names: &'static [&'static str],
    /// Short flags that take a value, glued (`-A3`) or as the next word.
    short: &'static str,
    /// Long flags that take the next word as a value; `--flag=x` is one word.
    long: &'static [&'static str],
    /// Flags whose value is the pattern, so no operand is.
    pattern: &'static [&'static str],
    /// Flags that read the pattern from a file, or drop it, so no operand
    /// is the pattern. A file value stays checked.
    no_operand: &'static [&'static str],
    /// Long flags that take two words (jq's `--arg NAME VALUE`).
    long2: &'static [&'static str],
}

/// The tools history shows naming a secret only in their pattern: grep and
/// rg searches and jq filters. sed and awk scripts never did, so they keep
/// every word checked.
const ROLES: &[Roles] = &[
    Roles {
        names: &["grep", "egrep", "fgrep"],
        short: "ABCDdefm",
        long: &[
            "--after-context",
            "--before-context",
            "--context",
            "--devices",
            "--directories",
            "--regexp",
            "--file",
            "--max-count",
            "--include",
            "--exclude",
            "--exclude-dir",
            "--exclude-from",
            "--label",
            "--binary-files",
        ],
        pattern: &["-e", "--regexp"],
        no_operand: &["-f", "--file"],
        long2: &[],
    },
    Roles {
        names: &["rg"],
        short: "ABCEMTdefgjmrt",
        long: &[
            "--after-context",
            "--before-context",
            "--context",
            "--encoding",
            "--max-columns",
            "--type-not",
            "--max-depth",
            "--regexp",
            "--file",
            "--glob",
            "--iglob",
            "--threads",
            "--max-count",
            "--replace",
            "--type",
            "--color",
            "--colors",
            "--context-separator",
            "--dfa-size-limit",
            "--engine",
            "--field-context-separator",
            "--field-match-separator",
            "--hostname-bin",
            "--hyperlink-format",
            "--ignore-file",
            "--max-filesize",
            "--path-separator",
            "--pre",
            "--pre-glob",
            "--regex-size-limit",
            "--sort",
            "--sortr",
            "--type-add",
            "--type-clear",
            "--generate",
        ],
        pattern: &["-e", "--regexp"],
        no_operand: &["-f", "--file", "--files", "--type-list"],
        long2: &[],
    },
    Roles {
        names: &["jq"],
        short: "fL",
        long: &["--indent", "--from-file", "--tab-width"],
        pattern: &[],
        no_operand: &["-f", "--from-file"],
        long2: &["--arg", "--argjson", "--slurpfile", "--rawfile"],
    },
];

/// The words of `seg` that are a pattern or a program, not a file: the
/// first operand of the segment's first reader, when that reader is one
/// of `ROLES`, or each `-e` value. Only the first reader counts, so in
/// `cat rg .env` the `.env` is still cat's file.
fn pattern_words(seg: &Segment) -> Vec<usize> {
    let w = &seg.words;
    let Some(k) = w.iter().position(|x| READERS.contains(&x.base())) else {
        return Vec::new();
    };
    let Some(roles) = ROLES.iter().find(|r| r.names.contains(&w[k].base())) else {
        return Vec::new();
    };
    let mut skip = Vec::new();
    let mut operands = Vec::new();
    let mut explicit = false;
    let mut options = true;
    let mut i = k + 1;
    while i < w.len() {
        let v = w[i].value.as_str();
        if options && v == "--" {
            options = false;
        } else if options && v.starts_with("--") {
            let (name, glued) = v.split_once('=').map_or((v, false), |(n, _)| (n, true));
            if roles.pattern.contains(&name) {
                explicit = true;
                if !glued {
                    i += 1;
                }
                skip.push(i);
            } else if roles.no_operand.contains(&name) {
                explicit = true;
                if !glued && roles.long.contains(&name) {
                    i += 1;
                }
            } else if roles.long2.contains(&name) {
                i += 2;
            } else if !glued && roles.long.contains(&name) {
                i += 1;
            }
        } else if options && v.len() > 1 && v.starts_with('-') {
            for (p, c) in v[1..].char_indices() {
                if !roles.short.contains(c) {
                    continue;
                }
                let flag = format!("-{c}");
                let glued = p + c.len_utf8() < v.len() - 1;
                if !glued {
                    i += 1;
                }
                if roles.pattern.contains(&flag.as_str()) {
                    explicit = true;
                    skip.push(i);
                } else if roles.no_operand.contains(&flag.as_str()) {
                    explicit = true;
                }
                break;
            }
        } else {
            operands.push(i);
        }
        i += 1;
    }
    if !explicit {
        skip.extend(operands.first());
    }
    skip
}
