//! The derived index: a SQLite cache of hooky's day files.
//!
//! The JSONL files are the record (`docs/spikes/2026-11-16-hook-hooky.md`,
//! "Decisions for the real crate"); data flows one way, from the files to this
//! index, which may be deleted at any time. So it never migrates: a schema or
//! derivation change bumps `SCHEMA`, and an index with another version is
//! dropped and rebuilt from the files.
//!
//! Reading never takes hooky's `flock`: hooky waits 500 ms for it and then
//! drops its line. hooky writes each line whole with one `write`, so the
//! reader consumes only up to the last newline and picks up the rest later.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use rusqlite::{Connection, ErrorCode, OptionalExtension, params};

use crate::record::{Record, Trouble, short_name};
use crate::space::Harness;

/// Bump on any change to the tables or to what `Record` derives into them.
const SCHEMA: i32 = 6;

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

/// One handler's trouble on one hook event: an issue on the Health screen,
/// and what the Log narrows to from there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueKey {
    pub kind: Trouble,
    pub command: String,
    pub event: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub key: IssueKey,
    pub name: String,
    /// The events it happened on: the rows the Log lists for it.
    pub events: usize,
    /// Of those, the tool calls that went ahead (`Record::let_through`).
    pub let_through: usize,
    /// What went wrong the last time.
    pub detail: String,
}

/// Middle values over one day's Bash tool calls (PreToolUse with tool Bash),
/// in milliseconds.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Timing {
    pub events: usize,
    /// hooky's whole run: what the call waited.
    pub total: u64,
    /// Each run less its slowest handler: what hooky adds to the handlers,
    /// which run side by side.
    pub overhead: u64,
    /// Each handler that answers, by short name, slowest first.
    pub handlers: Vec<(String, u64)>,
}

/// The middle value; of an even count, the higher of the two.
fn median(mut v: Vec<i64>) -> u64 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[v.len() / 2].max(0) as u64
}

/// Deletes one day's events, their troubles and their timings.
fn drop_day(tx: &rusqlite::Transaction, day: &str) -> Result<(), String> {
    for table in ["troubles", "timings"] {
        let q =
            format!("DELETE FROM {table} WHERE event_id IN (SELECT id FROM events WHERE day = ?1)");
        tx.execute(&q, [day]).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM events WHERE day = ?1", [day])
        .map_err(|e| e.to_string())?;
    Ok(())
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
         DROP TABLE IF EXISTS troubles;
         DROP TABLE IF EXISTS timings;
         CREATE TABLE files (day TEXT PRIMARY KEY, indexed INTEGER NOT NULL);
         CREATE TABLE events (
             id INTEGER PRIMARY KEY,
             day TEXT NOT NULL,
             offset INTEGER NOT NULL,
             ts_ms INTEGER NOT NULL,
             harness TEXT NOT NULL,
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
         );
         CREATE TABLE troubles (
             event_id INTEGER NOT NULL,
             kind TEXT NOT NULL,
             command TEXT NOT NULL,
             detail TEXT NOT NULL,
             let_through INTEGER NOT NULL
         );
         CREATE INDEX troubles_event ON troubles (event_id);
         CREATE TABLE timings (
             event_id INTEGER NOT NULL,
             name TEXT NOT NULL,
             ms INTEGER NOT NULL
         );
         CREATE INDEX timings_event ON timings (event_id);",
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
    /// The index copies hooky's lines, and tool input can carry secrets, so it
    /// keeps hooky's own modes: a new directory 0700, the database files 0600.
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
            drop_day(&tx, day)?;
            tx.execute("DELETE FROM files WHERE day = ?1", [day])
                .map_err(|e| e.to_string())?;
        }
        let mut added = 0;
        let mut levels = Vec::new();
        for (day, size) in grown {
            let mut from = self.indexed.get(&day).copied().unwrap_or(0);
            if size < from {
                drop_day(&tx, &day)?;
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

    /// One harness's events of one day in the order hooky wrote them, as a tail reads, narrowed
    /// to one hook event, to lines containing `search` (ASCII case-insensitive), and to the
    /// events where one handler had one kind of trouble.
    ///
    /// hooky writes a line when its event finishes, so a slow event lands after quicker ones
    /// that started later (3% of one day's lines). File order puts every new line at the end:
    /// sorted by time, a late line would land among the rows on screen and push them down.
    pub fn rows(
        &self,
        day: &str,
        harness: Harness,
        event: Option<&str>,
        search: &str,
        issue: Option<&IssueKey>,
    ) -> Vec<Row> {
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
                 WHERE day = ?1 AND harness = ?2 AND (?3 IS NULL OR event = ?3)
                   AND haystack LIKE ?4 ESCAPE '\\'
                   AND (?5 IS NULL OR EXISTS (SELECT 1 FROM troubles t
                        WHERE t.event_id = events.id AND t.kind = ?5 AND t.command = ?6))
                 ORDER BY offset";
        let Ok(mut stmt) = self.conn.prepare_cached(q) else {
            return Vec::new();
        };
        let kind = issue.map(|i| i.kind.as_str());
        let command = issue.map(|i| i.command.as_str());
        stmt.query_map(
            params![day, harness.name(), event, pattern, kind, command],
            |r| {
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
            },
        )
        .and_then(Iterator::collect)
        .unwrap_or_default()
    }

    /// One harness's issues of one day: failures first, then the most frequent.
    pub fn issues(&self, day: &str, harness: Harness) -> Vec<Issue> {
        // With one max() in the query, SQLite takes the bare `detail` from the
        // row holding that max: the latest occurrence's.
        let q = "SELECT t.kind, t.command, e.event, COUNT(DISTINCT e.id),
                        COUNT(DISTINCT CASE WHEN t.let_through THEN e.id END),
                        t.detail, MAX(e.offset)
                 FROM troubles t JOIN events e ON e.id = t.event_id
                 WHERE e.day = ?1 AND e.harness = ?2
                 GROUP BY t.kind, t.command, e.event
                 ORDER BY t.kind = 'stderr', COUNT(DISTINCT e.id) DESC, t.command";
        let Ok(mut stmt) = self.conn.prepare_cached(q) else {
            return Vec::new();
        };
        stmt.query_map([day, harness.name()], |r| {
            let kind: String = r.get(0)?;
            let command: String = r.get(1)?;
            Ok(Issue {
                name: short_name(&command),
                key: IssueKey {
                    kind: Trouble::parse(&kind).unwrap_or(Trouble::Failed),
                    command,
                    event: r.get(2)?,
                },
                events: r.get::<_, i64>(3)? as usize,
                let_through: r.get::<_, i64>(4)? as usize,
                detail: r.get(5)?,
            })
        })
        .and_then(Iterator::collect)
        .unwrap_or_default()
    }

    /// One harness's Bash timings of one day.
    pub fn timing(&self, day: &str, harness: Harness) -> Timing {
        let q = "SELECT e.id, e.ms, h.name, h.ms
                 FROM events e JOIN timings h ON h.event_id = e.id
                 WHERE e.day = ?1 AND e.harness = ?2
                 ORDER BY e.id";
        let Ok(mut stmt) = self.conn.prepare_cached(q) else {
            return Timing::default();
        };
        let runs: Vec<(i64, i64, String, i64)> = stmt
            .query_map([day, harness.name()], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .and_then(Iterator::collect)
            .unwrap_or_default();
        let mut totals = Vec::new();
        let mut overheads = Vec::new();
        let mut by_handler: HashMap<String, Vec<i64>> = HashMap::new();
        for event in runs.chunk_by(|a, b| a.0 == b.0) {
            let (_, ms, _, _) = event[0];
            let slowest = event.iter().map(|h| h.3).max().unwrap_or(0);
            totals.push(ms);
            overheads.push(ms - slowest);
            for (_, _, name, hms) in event {
                by_handler.entry(name.clone()).or_default().push(*hms);
            }
        }
        let mut handlers: Vec<(String, u64)> = by_handler
            .into_iter()
            .map(|(name, v)| (name, median(v)))
            .collect();
        handlers.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Timing {
            events: totals.len(),
            total: median(totals),
            overhead: median(overheads),
            handlers,
        }
    }

    /// Where an event's line sits: its day and offset, which outlive a rebuild
    /// that gives every event a new id.
    pub fn place(&self, id: i64) -> Option<(String, i64)> {
        self.conn
            .query_row("SELECT day, offset FROM events WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .ok()
            .flatten()
    }

    /// The event at a place, after a rebuild.
    pub fn id_at(&self, day: &str, offset: i64) -> Option<i64> {
        self.conn
            .query_row(
                "SELECT id FROM events WHERE day = ?1 AND offset = ?2",
                params![day, offset],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    /// The JSONL line behind a row, as hooky wrote it.
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

/// Indexes one line, with its handlers' troubles; a line that is not a hooky
/// record is skipped.
fn insert(tx: &rusqlite::Transaction, day: &str, offset: u64, line: &str) -> Result<usize, String> {
    let Some(r) = Record::parse(line) else {
        return Ok(0);
    };
    let n = tx.execute(
        "INSERT OR IGNORE INTO events (day, offset, ts_ms, harness, time, event, tool, input, verdict, stderr, ms, haystack, line)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            day,
            offset as i64,
            r.ts_ms,
            r.harness.name(),
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
    .map_err(|e| e.to_string())?;
    if n == 0 {
        return Ok(0);
    }
    let id = tx.last_insert_rowid();
    // Each Bash call's handler times, which Health takes the middle of. Kept
    // apart from the line so that reading them parses no JSON: Health reads
    // them on every look that brings rows.
    if r.event == "PreToolUse" && r.tool.as_deref() == Some("Bash") && r.ms.is_some() {
        for h in &r.handlers {
            if let Some(ms) = h.ms {
                tx.execute(
                    "INSERT INTO timings (event_id, name, ms) VALUES (?1, ?2, ?3)",
                    params![id, h.name, ms as i64],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    // One trouble per kind and command: a command listed under two matchers
    // runs twice, but the event is one row.
    let mut seen: Vec<(Trouble, &str)> = Vec::new();
    for h in &r.handlers {
        let Some((kind, detail)) = h.trouble() else {
            continue;
        };
        if seen.contains(&(kind, h.command.as_str())) {
            continue;
        }
        seen.push((kind, &h.command));
        tx.execute(
            "INSERT INTO troubles (event_id, kind, command, detail, let_through)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                kind.as_str(),
                h.command,
                detail,
                kind == Trouble::Failed && r.let_through()
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hooky-console-{name}-{}", std::process::id()));
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
        let rows = ix.rows("2026-11-16", Harness::Claude, None, "", None);
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
        assert_eq!(
            ix.rows("2026-11-16", Harness::Claude, Some("PreToolUse"), "", None)
                .len(),
            2
        );
        assert_eq!(
            ix.rows("2026-11-16", Harness::Claude, None, "GIT", None)
                .len(),
            2
        );
        assert_eq!(
            ix.rows(
                "2026-11-16",
                Harness::Claude,
                Some("PreToolUse"),
                "git",
                None
            )
            .len(),
            1
        );
        assert_eq!(
            ix.rows("2026-11-16", Harness::Claude, None, "100%", None)
                .len(),
            0,
            "% is literal"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn each_harness_lists_counts_and_times_only_its_own_events() {
        let codex = |l: String| l.replacen(r#"{"v":1,"#, r#"{"v":1,"harness":"codex","#, 1);
        let mut ix = Index::memory();
        let day = crate::sample::DAY;
        let claude = crate::sample::trouble_lines();
        ix.insert_lines(day, &claude).unwrap();
        ix.insert_lines(
            day,
            &[codex(line(
                "2026-11-16T15:00:00.000+05:00",
                "PreToolUse",
                "cargo test",
            ))],
        )
        .unwrap();
        let rows = |h| ix.rows(day, h, None, "", None);
        assert_eq!(rows(Harness::Claude).len(), claude.len());
        let codex_rows = rows(Harness::Codex);
        assert_eq!(codex_rows.len(), 1);
        assert_eq!(codex_rows[0].input.as_deref(), Some("cargo test"));
        assert_eq!(ix.rows(day, Harness::Codex, None, "git", None).len(), 0);
        assert_eq!(ix.issues(day, Harness::Claude).len(), 4);
        assert!(ix.issues(day, Harness::Codex).is_empty());
        assert_eq!(ix.timing(day, Harness::Claude).events, 6);
        assert_eq!(ix.timing(day, Harness::Codex), Timing::default());
    }

    #[test]
    fn rows_keep_the_order_hooky_wrote_them_in() {
        let mut ix = Index::memory();
        let day = "2026-11-16";
        // A slow event that started first finishes, and is written, after a quick one.
        let quick = line("2026-11-16T10:00:05.000+05:00", "PreToolUse", "quick");
        let slow = line("2026-11-16T10:00:01.000+05:00", "PreToolUse", "slow");
        ix.insert_lines(day, &[quick]).unwrap();
        ix.insert_lines(day, &[slow]).unwrap();
        let inputs: Vec<String> = ix
            .rows(day, Harness::Claude, None, "", None)
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
        let rows = ix.rows("2026-11-16", Harness::Claude, None, "", None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input.as_deref(), Some("c"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_cache_keeps_hooky_s_private_modes() {
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

    #[test]
    fn each_issue_counts_the_rows_its_filter_lists() {
        let mut ix = Index::memory();
        let day = crate::sample::DAY;
        ix.insert_lines(day, &crate::sample::trouble_lines())
            .unwrap();
        let issues = ix.issues(day, Harness::Claude);
        let named: Vec<(&str, &str, &str, usize, usize)> = issues
            .iter()
            .map(|i| {
                let k = &i.key;
                (
                    k.kind.as_str(),
                    i.name.as_str(),
                    k.event.as_str(),
                    i.events,
                    i.let_through,
                )
            })
            .collect();
        assert_eq!(
            named,
            [
                ("failed", "no-secrets.sh", "PreToolUse", 3, 3),
                ("failed", "turn-check.sh", "UserPromptSubmit", 1, 0),
                ("failed", "notify-done", "Notification", 1, 0),
                ("stderr", "stop-verify.sh", "Stop", 2, 0),
            ]
        );
        for i in &issues {
            let listed = ix
                .rows(day, Harness::Claude, Some(&i.key.event), "", Some(&i.key))
                .len();
            assert_eq!(listed, i.events, "{} lists what it counts", i.name);
        }
        assert!(issues[0].detail.contains("bad substitution"));
        assert_eq!(issues[1].detail, "timed out");
        assert!(
            issues[2].detail.starts_with("failed to start"),
            "an async handler that cannot start"
        );
        assert!(issues[3].detail.contains("getcwd"));
    }

    #[test]
    fn a_denied_call_is_not_let_through_and_an_exit_2_reason_is_no_issue() {
        let h = |cmd: &str, exit: i64, outcome: &str| {
            serde_json::json!({"matcher": "Bash", "command": cmd, "exit": exit, "ms": 5,
                "outcome": outcome, "stderr": "boom\n"})
        };
        let ev = |decision: Option<&str>, hs: Vec<serde_json::Value>| {
            serde_json::json!({"v": 1, "ts": "2026-11-16T10:00:00.000+05:00", "event": "PreToolUse",
                "tool": "Bash", "input": "x", "mode": "merged", "decision": decision, "exit": 0,
                "ms": 9, "handlers": hs})
            .to_string()
        };
        let mut ix = Index::memory();
        let day = "2026-11-16";
        ix.insert_lines(
            day,
            &[
                ev(
                    Some("deny"),
                    vec![h("a/guard.sh", 1, "error"), h("a/deny.sh", 2, "deny")],
                ),
                ev(None, vec![h("a/guard.sh", 1, "error")]),
            ],
        )
        .unwrap();
        let issues = ix.issues(day, Harness::Claude);
        assert_eq!(issues.len(), 1, "exit 2's stderr is its reason: {issues:?}");
        assert_eq!((issues[0].events, issues[0].let_through), (2, 1));
    }

    #[test]
    fn timing_takes_middle_values_and_what_hooky_adds_to_its_slowest_handler() {
        let ev = |event: &str, ms: i64, a: i64, b: i64| {
            serde_json::json!({"v": 1, "ts": "2026-11-16T10:00:00.000+05:00", "event": event,
                "tool": "Bash", "mode": "silent", "decision": null, "exit": 0, "ms": ms, "handlers": [
                    {"command": "x/a.sh", "exit": 0, "ms": a, "outcome": "none"},
                    {"command": "python3 x/b.py", "exit": 0, "ms": b, "outcome": "none"},
                    {"command": "x/c.sh", "async": true}]})
            .to_string()
        };
        let mut ix = Index::memory();
        let day = "2026-11-16";
        ix.insert_lines(
            day,
            &[
                ev("PreToolUse", 40, 30, 10),
                ev("PreToolUse", 50, 35, 20),
                ev("PreToolUse", 900, 880, 15),
                ev("PostToolUse", 5000, 4990, 1),
            ],
        )
        .unwrap();
        let t = ix.timing(day, Harness::Claude);
        assert_eq!((t.events, t.total, t.overhead), (3, 50, 15));
        assert_eq!(
            t.handlers,
            [("a.sh".to_string(), 35), ("b.py".to_string(), 15)]
        );
        assert_eq!(ix.timing("2026-11-17", Harness::Claude), Timing::default());
    }

    #[test]
    fn a_pruned_day_takes_its_troubles_and_timings_with_it() {
        let dir = scratch("troubles");
        let file = dir.join(format!("{}.jsonl", crate::sample::DAY));
        append(&file, &(crate::sample::trouble_lines().join("\n") + "\n"));
        let mut ix = Index::memory();
        ix.sync(&dir).unwrap();
        assert_eq!(ix.issues(crate::sample::DAY, Harness::Claude).len(), 4);
        assert_eq!(ix.timing(crate::sample::DAY, Harness::Claude).events, 6);
        fs::remove_file(&file).unwrap();
        ix.sync(&dir).unwrap();
        let left: i64 = ix
            .conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM troubles) + (SELECT COUNT(*) FROM timings)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
        fs::remove_dir_all(&dir).unwrap();
    }
}
