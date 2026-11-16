//! The derived index: a SQLite cache of route's day files.
//!
//! The JSONL files are the record (`docs/spikes/2026-11-16-hook-route.md`,
//! "Decisions for the real crate"); data flows one way, from the files to this
//! index, which may be deleted at any time. So it never migrates: a schema or
//! derivation change bumps `SCHEMA`, and an index with another version is
//! dropped and rebuilt from the files.
//!
//! Reading never takes route's `flock`: route waits 500 ms for it and then
//! drops its line. route writes each line whole with one `write`, so the
//! reader consumes only up to the last newline and picks up the rest later.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use rusqlite::{Connection, ErrorCode, OptionalExtension, params};

use crate::record::Record;

/// Bump on any change to the tables or to what `Record` derives into them.
const SCHEMA: i32 = 3;

pub struct Index {
    conn: Connection,
    /// Bytes indexed per day file, mirrored from the `files` table so a sync
    /// with nothing new costs one `stat` per file and no query.
    indexed: HashMap<String, u64>,
}

/// One table row: what the Log list shows.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: i64,
    pub time: String,
    pub event: String,
    pub tool: Option<String>,
    pub input: Option<String>,
    pub verdict: Option<String>,
    pub stderr: bool,
    pub ms: Option<u64>,
}

/// The day a file holds, from its name: `2026-11-16.jsonl` holds `2026-11-16`.
fn day_of(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".jsonl")?;
    chrono::NaiveDate::parse_from_str(stem, "%Y-%m-%d")
        .ok()
        .map(|_| stem)
}

fn create(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS events;
         DROP TABLE IF EXISTS files;
         CREATE TABLE files (day TEXT PRIMARY KEY, indexed INTEGER NOT NULL);
         CREATE TABLE events (
             id INTEGER PRIMARY KEY,
             day TEXT NOT NULL,
             offset INTEGER NOT NULL,
             ts_ms INTEGER NOT NULL,
             time TEXT NOT NULL,
             event TEXT NOT NULL,
             tool TEXT,
             input TEXT,
             verdict TEXT,
             stderr INTEGER NOT NULL,
             ms INTEGER,
             haystack TEXT NOT NULL,
             line TEXT NOT NULL,
             UNIQUE (day, offset)
         );",
    )?;
    conn.pragma_update(None, "user_version", SCHEMA)
}

fn prepare(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // Rows dropped with a pruned day file are zeroed on disk, not left in
    // free pages.
    conn.pragma_update(None, "secure_delete", true)?;
    let version: i32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version != SCHEMA {
        create(conn)?;
    }
    Ok(())
}

impl Index {
    /// Opens the index at `path`, or starts it over when it is unreadable or
    /// from another schema.
    ///
    /// The index copies route's lines, and tool input can carry secrets, so it
    /// keeps route's own modes: a new directory 0700, the database files 0600.
    pub fn open(path: &Path) -> Result<Index, String> {
        if let Some(dir) = path.parent() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let files = |suffixes: &[&str]| {
            suffixes
                .iter()
                .map(|s| format!("{}{s}", path.display()))
                .collect::<Vec<_>>()
        };
        let attempt = || -> rusqlite::Result<Connection> {
            // SQLite gives -wal and -shm the main file's mode, so the main
            // file is made private before SQLite creates it.
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .mode(0o600)
                .open(path);
            for f in files(&["", "-wal", "-shm"]) {
                let _ = fs::set_permissions(&f, fs::Permissions::from_mode(0o600));
            }
            let conn = Connection::open(path)?;
            prepare(&conn)?;
            Ok(conn)
        };
        // Only a file that is not a database is replaced. A lock held by
        // another window is an error to report, not a reason to delete.
        let conn = match attempt() {
            Err(e)
                if matches!(
                    e.sqlite_error_code(),
                    Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
                ) =>
            {
                for f in files(&["", "-wal", "-shm"]) {
                    let _ = fs::remove_file(f);
                }
                attempt()
            }
            other => other,
        };
        Index::with(conn.map_err(|e| format!("{}: {e}", path.display()))?)
    }

    /// An index that lives only in memory, for tests and sample scenes.
    pub fn memory() -> Index {
        let conn = Connection::open_in_memory().expect("an in-memory database opens");
        create(&conn).expect("tables create");
        Index::with(conn).expect("an empty index loads")
    }

    fn with(conn: Connection) -> Result<Index, String> {
        let indexed = {
            let mut q = conn
                .prepare("SELECT day, indexed FROM files")
                .map_err(|e| e.to_string())?;
            q.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })
            .and_then(Iterator::collect)
            .map_err(|e| e.to_string())?
        };
        Ok(Index { conn, indexed })
    }

    /// Drops everything and indexes the files again.
    pub fn rebuild(&mut self, dir: &Path) -> Result<usize, String> {
        create(&self.conn).map_err(|e| e.to_string())?;
        self.indexed.clear();
        self.sync(dir)
    }

    /// Brings the index level with the day files in `dir`: new lines in, the
    /// lines of deleted files out, and a file that shrank (rewritten by hand)
    /// indexed again from its start. Returns how many events came in.
    pub fn sync(&mut self, dir: &Path) -> Result<usize, String> {
        let mut sizes: HashMap<String, u64> = HashMap::new();
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if let (Some(day), Ok(meta)) = (name.to_str().and_then(day_of), entry.metadata()) {
                    sizes.insert(day.to_string(), meta.len());
                }
            }
        }
        let gone: Vec<String> = self
            .indexed
            .keys()
            .filter(|d| !sizes.contains_key(*d))
            .cloned()
            .collect();
        let grown: Vec<(String, u64)> = sizes
            .iter()
            .filter(|(day, size)| self.indexed.get(*day) != Some(size))
            .map(|(d, s)| (d.clone(), *s))
            .collect();
        if gone.is_empty() && grown.is_empty() {
            return Ok(0);
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for day in &gone {
            tx.execute("DELETE FROM events WHERE day = ?1", [day])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM files WHERE day = ?1", [day])
                .map_err(|e| e.to_string())?;
        }
        let mut added = 0;
        let mut levels = Vec::new();
        for (day, size) in grown {
            let mut from = self.indexed.get(&day).copied().unwrap_or(0);
            if size < from {
                tx.execute("DELETE FROM events WHERE day = ?1", [&day])
                    .map_err(|e| e.to_string())?;
                from = 0;
            }
            let (n, upto) = ingest(&tx, &dir.join(format!("{day}.jsonl")), &day, from)?;
            added += n;
            tx.execute(
                "INSERT INTO files (day, indexed) VALUES (?1, ?2)
                 ON CONFLICT (day) DO UPDATE SET indexed = excluded.indexed",
                params![day, upto as i64],
            )
            .map_err(|e| e.to_string())?;
            levels.push((day, upto));
        }
        tx.commit().map_err(|e| e.to_string())?;
        for day in gone {
            self.indexed.remove(&day);
        }
        self.indexed.extend(levels);
        Ok(added)
    }

    /// Indexes lines given directly, as if appended to one day's file: after
    /// whatever that day already holds.
    pub fn insert_lines(&mut self, day: &str, lines: &[String]) -> Result<usize, String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut n = 0;
        let mut offset: u64 = tx
            .query_row(
                "SELECT COALESCE(MAX(offset) + 1, 0) FROM events WHERE day = ?1",
                [day],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())? as u64;
        for line in lines {
            n += insert(&tx, day, offset, line)?;
            offset += line.len() as u64 + 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n)
    }

    /// The days indexed, newest first.
    pub fn days(&self) -> Vec<String> {
        let mut days: Vec<String> = self.indexed.keys().cloned().collect();
        days.sort_unstable_by(|a, b| b.cmp(a));
        days
    }

    /// One day's events in the order route wrote them, as a tail reads, narrowed to one hook
    /// event and to lines containing `search` (ASCII case-insensitive).
    ///
    /// route writes a line when its event finishes, so a slow event lands after quicker ones
    /// that started later (3% of one day's lines). File order puts every new line at the end:
    /// sorted by time, a late line would land among the rows on screen and push them down.
    pub fn rows(&self, day: &str, event: Option<&str>, search: &str) -> Vec<Row> {
        let pattern = format!(
            "%{}%",
            search
                .trim()
                .to_lowercase()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let q = "SELECT id, time, event, tool, input, verdict, stderr, ms FROM events
                 WHERE day = ?1 AND (?2 IS NULL OR event = ?2) AND haystack LIKE ?3 ESCAPE '\\'
                 ORDER BY offset";
        let Ok(mut stmt) = self.conn.prepare_cached(q) else {
            return Vec::new();
        };
        stmt.query_map(params![day, event, pattern], |r| {
            Ok(Row {
                id: r.get(0)?,
                time: r.get(1)?,
                event: r.get(2)?,
                tool: r.get(3)?,
                input: r.get(4)?,
                verdict: r.get(5)?,
                stderr: r.get(6)?,
                ms: r.get::<_, Option<i64>>(7)?.map(|m| m as u64),
            })
        })
        .and_then(Iterator::collect)
        .unwrap_or_default()
    }

    /// The JSONL line behind a row, as route wrote it.
    pub fn line(&self, id: i64) -> Option<String> {
        self.conn
            .query_row("SELECT line FROM events WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }
}

/// Reads `path` from byte `from` to its last newline and indexes each line.
/// Returns the events added and the offset indexed up to.
fn ingest(
    tx: &rusqlite::Transaction,
    path: &Path,
    day: &str,
    from: u64,
) -> Result<(usize, u64), String> {
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    file.seek(SeekFrom::Start(from))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let Some(last) = bytes.iter().rposition(|&b| b == b'\n') else {
        return Ok((0, from));
    };
    let mut added = 0;
    let mut start = 0;
    for (i, &b) in bytes[..=last].iter().enumerate() {
        if b == b'\n' {
            if let Ok(line) = std::str::from_utf8(&bytes[start..i]) {
                added += insert(tx, day, from + start as u64, line)?;
            }
            start = i + 1;
        }
    }
    Ok((added, from + last as u64 + 1))
}

/// Indexes one line; a line that is not a route record is skipped.
fn insert(tx: &rusqlite::Transaction, day: &str, offset: u64, line: &str) -> Result<usize, String> {
    let Some(r) = Record::parse(line) else {
        return Ok(0);
    };
    tx.execute(
        "INSERT OR IGNORE INTO events (day, offset, ts_ms, time, event, tool, input, verdict, stderr, ms, haystack, line)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            day,
            offset as i64,
            r.ts_ms,
            r.time(),
            r.event,
            r.tool,
            r.input,
            r.verdict(),
            r.has_stderr(),
            r.ms.map(|m| m as i64),
            r.haystack(),
            line
        ],
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("route-console-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn line(ts: &str, event: &str, input: &str) -> String {
        serde_json::json!({"v": 1, "ts": ts, "event": event, "mode": "silent", "decision": null,
            "exit": 0, "ms": 5, "handlers": [], "tool": "Bash", "input": input})
        .to_string()
    }

    fn append(path: &Path, text: &str) {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn sync_reads_whole_lines_only_and_resumes() {
        let dir = scratch("resume");
        let file = dir.join("2026-11-16.jsonl");
        let a = line("2026-11-16T10:00:00.000+05:00", "PreToolUse", "ls");
        let b = line("2026-11-16T10:00:01.000+05:00", "PostToolUse", "ls");
        append(&file, &format!("{a}\n{}", &b[..10]));
        let mut ix = Index::open(&dir.join("ix/index.sqlite")).unwrap();
        assert_eq!(ix.sync(&dir).unwrap(), 1);
        assert_eq!(ix.sync(&dir).unwrap(), 0, "a half line waits");
        append(&file, &format!("{}\n", &b[10..]));
        assert_eq!(ix.sync(&dir).unwrap(), 1);
        let rows = ix.rows("2026-11-16", None, "");
        assert_eq!(
            rows.iter().map(|r| r.event.as_str()).collect::<Vec<_>>(),
            ["PreToolUse", "PostToolUse"]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn filters_narrow_by_event_and_text() {
        let dir = scratch("filter");
        let lines = [
            line("2026-11-16T10:00:00.000+05:00", "PreToolUse", "git status"),
            line("2026-11-16T10:00:01.000+05:00", "PreToolUse", "cargo test"),
            line("2026-11-16T10:00:02.000+05:00", "PostToolUse", "git status"),
        ];
        append(&dir.join("2026-11-16.jsonl"), &(lines.join("\n") + "\n"));
        let mut ix = Index::memory();
        ix.sync(&dir).unwrap();
        assert_eq!(ix.rows("2026-11-16", Some("PreToolUse"), "").len(), 2);
        assert_eq!(ix.rows("2026-11-16", None, "GIT").len(), 2);
        assert_eq!(ix.rows("2026-11-16", Some("PreToolUse"), "git").len(), 1);
        assert_eq!(ix.rows("2026-11-16", None, "100%").len(), 0, "% is literal");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rows_keep_the_order_route_wrote_them_in() {
        let mut ix = Index::memory();
        let day = "2026-11-16";
        // A slow event that started first finishes, and is written, after a quick one.
        let quick = line("2026-11-16T10:00:05.000+05:00", "PreToolUse", "quick");
        let slow = line("2026-11-16T10:00:01.000+05:00", "PreToolUse", "slow");
        ix.insert_lines(day, &[quick]).unwrap();
        ix.insert_lines(day, &[slow]).unwrap();
        let inputs: Vec<String> = ix
            .rows(day, None, "")
            .into_iter()
            .filter_map(|r| r.input)
            .collect();
        assert_eq!(inputs, ["quick", "slow"], "the late line lands at the end");
    }

    #[test]
    fn deleted_and_rewritten_files_leave_the_index() {
        let dir = scratch("prune");
        let old = dir.join("2026-10-01.jsonl");
        let today = dir.join("2026-11-16.jsonl");
        append(
            &old,
            &(line("2026-10-01T10:00:00.000+05:00", "Stop", "") + "\n"),
        );
        append(
            &today,
            &(line("2026-11-16T10:00:00.000+05:00", "Stop", "a") + "\n"),
        );
        append(
            &today,
            &(line("2026-11-16T10:00:01.000+05:00", "Stop", "b") + "\n"),
        );
        let mut ix = Index::memory();
        assert_eq!(ix.sync(&dir).unwrap(), 3);
        fs::remove_file(&old).unwrap();
        fs::write(
            &today,
            line("2026-11-16T11:00:00.000+05:00", "Stop", "c") + "\n",
        )
        .unwrap();
        ix.sync(&dir).unwrap();
        assert_eq!(ix.days(), ["2026-11-16"]);
        let rows = ix.rows("2026-11-16", None, "");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input.as_deref(), Some("c"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_cache_keeps_route_s_private_modes() {
        let dir = scratch("modes");
        let path = dir.join("cache/index.sqlite");
        append(
            &dir.join("2026-11-16.jsonl"),
            &(line("2026-11-16T10:00:00.000+05:00", "Stop", "secret") + "\n"),
        );
        let mut ix = Index::open(&path).unwrap();
        ix.sync(&dir).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join("cache")), 0o700);
        for f in ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"] {
            assert_eq!(mode(&dir.join("cache").join(f)), 0o600, "{f}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn another_schema_starts_over_and_a_broken_file_is_replaced() {
        let dir = scratch("schema");
        let path = dir.join("index.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE stale (x); PRAGMA user_version = 99;")
                .unwrap();
        }
        let ix = Index::open(&path).unwrap();
        assert!(ix.days().is_empty());
        drop(ix);
        fs::write(&path, b"not a database at all, just bytes").unwrap();
        let _ = fs::remove_file(dir.join("index.sqlite-wal"));
        assert!(Index::open(&path).is_ok());
        fs::remove_dir_all(&dir).unwrap();
    }
}
