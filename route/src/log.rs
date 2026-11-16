//! The event log: one JSON line per event, one file per local day.
//!
//! JSONL is the record (decided 2026-11-16); a viewer may build an index from
//! it and drop that index at will. Each line is built whole, newline included,
//! and written with one `write` while route holds `flock` on the file, so lines
//! from concurrent route processes never interleave. The log records tool
//! input, which can carry secrets, so input and handler output are truncated,
//! and day files past the retention age are deleted.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDate};
use serde_json::Value;

/// How long route waits for another writer's lock before it drops its line.
/// A log line is never worth holding up a tool call.
pub const LOCK_WAIT: Duration = Duration::from_millis(500);

/// Cuts text to `max` characters and says how much it dropped.
pub fn truncate(s: &str, max: usize) -> String {
    let total = s.chars().count();
    if total <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}…[+{} chars]", total - max)
}

/// The event's input text worth a log line: a Bash command, a file path, a
/// prompt, or else the compact tool input.
pub fn input_summary(payload: &Value) -> Option<String> {
    if let Some(input) = payload.get("tool_input") {
        for key in ["command", "file_path", "url", "query", "pattern"] {
            if let Some(s) = input.get(key).and_then(Value::as_str) {
                return Some(s.to_string());
            }
        }
        return Some(input.to_string());
    }
    payload
        .get("prompt")
        .and_then(Value::as_str)
        .map(String::from)
}

/// Appends one line, holding `flock` for the single write.
pub fn append(
    dir: &Path,
    line: &[u8],
    retention_days: u32,
    now: DateTime<Local>,
) -> Result<(), String> {
    debug_assert!(line.ends_with(b"\n"));
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?;
    let today = now.date_naive();
    let path = dir.join(format!("{}.jsonl", today.format("%Y-%m-%d")));
    let new_day = !path.exists();
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    lock(&file).map_err(|e| format!("{}: {e}", path.display()))?;
    let written = file.write_all(line);
    let _ = file.unlock();
    written.map_err(|e| format!("{}: {e}", path.display()))?;
    if new_day && retention_days > 0 {
        prune(dir, today, retention_days);
    }
    Ok(())
}

fn lock(file: &File) -> Result<(), String> {
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(TryLockError::WouldBlock) => {
                return Err(format!("still locked after {LOCK_WAIT:?}; line dropped"));
            }
            Err(TryLockError::Error(e)) => return Err(e.to_string()),
        }
    }
}

/// Deletes day files older than the retention age. Runs once a day, when the
/// first line of a new day creates its file.
fn prune(dir: &Path, today: NaiveDate, retention_days: u32) {
    let Some(cutoff) = today.checked_sub_days(chrono::Days::new(u64::from(retention_days))) else {
        return;
    };
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".jsonl")) else {
            continue;
        };
        if let Ok(day) = NaiveDate::parse_from_str(stem, "%Y-%m-%d")
            && day < cutoff
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("route-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn noon(y: i32, m: u32, d: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap()
    }

    #[test]
    fn truncation_keeps_the_head_and_counts_the_rest() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdefghij", 4), "abcd…[+6 chars]");
        assert_eq!(truncate("ыыыы", 2), "ыы…[+2 chars]");
    }

    #[test]
    fn input_summary_prefers_the_command() {
        let p = serde_json::json!({"tool_input": {"command": "ls", "description": "list"}});
        assert_eq!(input_summary(&p).as_deref(), Some("ls"));
        let p = serde_json::json!({"prompt": "hi"});
        assert_eq!(input_summary(&p).as_deref(), Some("hi"));
    }

    #[test]
    fn lines_from_separate_opens_stay_whole() {
        let dir = scratch("concurrent");
        let now = noon(2026, 11, 16);
        let writers = 16;
        let per = 20;
        let handles: Vec<_> = (0..writers)
            .map(|w| {
                let dir = dir.clone();
                thread::spawn(move || {
                    for i in 0..per {
                        // Larger than PIPE_BUF and than one page, so a split
                        // write would show.
                        let body = format!("{w}-{i}-").repeat(4_000);
                        let line =
                            format!("{}\n", serde_json::json!({"w": w, "i": i, "body": body}));
                        append(&dir, line.as_bytes(), 0, now).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let text = fs::read_to_string(dir.join("2026-11-16.jsonl")).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), writers * per);
        for line in lines {
            let v: Value = serde_json::from_str(line).expect("every line parses whole");
            let expected = format!("{}-{}-", v["w"], v["i"]).repeat(4_000);
            assert_eq!(v["body"], expected);
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_held_lock_makes_the_append_wait_then_give_up() {
        let dir = scratch("held");
        let now = noon(2026, 11, 16);
        append(&dir, b"{\"first\":1}\n", 0, now).unwrap();
        let holder = File::open(dir.join("2026-11-16.jsonl")).unwrap();
        holder.lock().unwrap();
        let started = Instant::now();
        let err = append(&dir, b"{\"second\":2}\n", 0, now).unwrap_err();
        assert!(err.contains("line dropped"), "{err}");
        assert!(started.elapsed() >= LOCK_WAIT);
        holder.unlock().unwrap();
        append(&dir, b"{\"third\":3}\n", 0, now).unwrap();
        let text = fs::read_to_string(dir.join("2026-11-16.jsonl")).unwrap();
        assert_eq!(text, "{\"first\":1}\n{\"third\":3}\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_day_deletes_files_past_retention() {
        let dir = scratch("retention");
        fs::create_dir_all(&dir).unwrap();
        for name in [
            "2026-10-01.jsonl",
            "2026-11-08.jsonl",
            "2026-11-09.jsonl",
            "notes.txt",
        ] {
            fs::write(dir.join(name), "{}\n").unwrap();
        }
        append(&dir, b"{}\n", 7, noon(2026, 11, 16)).unwrap();
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, ["2026-11-09.jsonl", "2026-11-16.jsonl", "notes.txt"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
