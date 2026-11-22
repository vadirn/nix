//! `hooky install`: puts the hooks block `config::settings_block` builds into
//! a harness's settings file.
//!
//! - **Only `hooks` changes:** the new block replaces the bytes of the file's
//!   top-level `hooks` value, so every other key keeps its formatting. A file
//!   without `hooks` gains the key; a missing file is created.
//! - **Links stay links:** the write goes to the file a chain of links ends
//!   at, so a settings file linked from a repo keeps tracking it.
//! - **Foreign hooks refuse:** a hook whose command does not call hooky
//!   would be lost, so install names it and writes nothing.
//! - **No change, no write.**

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::value::RawValue;
use serde_json::{Map, Value};

/// What install did to the settings file.
pub enum Done {
    Unchanged,
    /// The events added, removed or changed, one line each.
    Wrote(Vec<String>),
}

/// Writes `hooks`, the settings block's `hooks` object, into `target`.
pub fn install(target: &Path, hooks: &Value) -> Result<Done, String> {
    let file = resolve(target)?;
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => "{}\n".to_string(),
        Err(e) => return Err(format!("reading {}: {e}", file.display())),
    };
    let top: BTreeMap<String, &RawValue> = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not a JSON object: {e}", file.display()))?;
    let old = match top.get("hooks") {
        Some(raw) => serde_json::from_str(raw.get())
            .map_err(|e| format!("{}: hooks: {e}", file.display()))?,
        None => Value::Object(Map::new()),
    };
    let foreign = foreign_hooks(&old, hooks);
    if !foreign.is_empty() {
        return Err(format!(
            "{} holds hooks that do not call hooky, and install would drop them:\n  {}\nMove each into hooky's hooks file, then run install again.",
            file.display(),
            foreign.join("\n  ")
        ));
    }
    if old == *hooks {
        return Ok(Done::Unchanged);
    }
    let new = splice(&text, top.get("hooks").copied(), hooks);
    write(&file, &new)?;
    Ok(Done::Wrote(changes(&old, hooks)))
}

/// The file a chain of links at `target` ends at, or `target` itself when
/// nothing is there yet.
fn resolve(target: &Path) -> Result<PathBuf, String> {
    match fs::canonicalize(target) {
        Ok(p) => Ok(p),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            if fs::symlink_metadata(target).is_ok() {
                Err(format!("{} is a link to a missing file", target.display()))
            } else {
                Ok(target.to_path_buf())
            }
        }
        Err(e) => Err(format!("{}: {e}", target.display())),
    }
}

/// Each hook under `old` that neither calls hooky nor is one `new` writes
/// itself, as `Event: command`.
fn foreign_hooks(old: &Value, new: &Value) -> Vec<String> {
    let mut found = Vec::new();
    let Some(events) = old.as_object() else {
        return vec![format!("hooks is not an object: {old}")];
    };
    for (event, entries) in events {
        let own: Vec<&Value> = new.get(event).map(handlers).into_iter().flatten().collect();
        for h in handlers(entries) {
            match h.get("command").and_then(Value::as_str) {
                _ if own.contains(&h) => {}
                Some(cmd) if calls_hooky(cmd, event) => {}
                Some(cmd) => found.push(format!("{event}: {cmd}")),
                None => found.push(format!("{event}: {h}")),
            }
        }
    }
    found
}

/// The handlers of one event's entries.
fn handlers(entries: &Value) -> impl Iterator<Item = &Value> {
    entries.as_array().into_iter().flatten().flat_map(|e| {
        e.get("hooks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
    })
}

/// Whether `cmd` is an entry hooky generates for `event`: one shell word
/// naming a file called `hooky`, an optional `--harness NAME`, then the
/// event. A command that runs hooky through another program is not one.
fn calls_hooky(cmd: &str, event: &str) -> bool {
    let Some(mut rest) = cmd.strip_suffix(event).and_then(|r| r.strip_suffix(' ')) else {
        return false;
    };
    if let Some((head, name)) = rest.rsplit_once(" --harness ")
        && !name.contains(' ')
    {
        rest = head;
    }
    let one_word = !rest.contains(char::is_whitespace)
        || ((rest.starts_with('\'') || rest.starts_with("~/'")) && rest.ends_with('\''));
    let bin = rest.trim_end_matches('\'');
    one_word && (bin == "hooky" || bin.ends_with("/hooky"))
}

/// `text` with its top-level `hooks` value, at `raw`, replaced by `hooks`, or
/// with the key added before the closing brace.
fn splice(text: &str, raw: Option<&RawValue>, hooks: &Value) -> String {
    match raw {
        Some(raw) => {
            let start = raw.get().as_ptr() as usize - text.as_ptr() as usize;
            let end = start + raw.get().len();
            let line = text[..start].rfind('\n').map_or(0, |i| i + 1);
            let indent = &text[line..line + leading_space(&text[line..])];
            format!(
                "{}{}{}",
                &text[..start],
                pretty(hooks, indent),
                &text[end..]
            )
        }
        None => {
            let close = text.rfind('}').expect("a JSON object ends in a brace");
            let body = text[..close].trim_end().len();
            let unit = text
                .lines()
                .map(|l| &l[..leading_space(l)])
                .find(|s| !s.is_empty())
                .unwrap_or("  ");
            let entry = format!("\"hooks\": {}", pretty(hooks, unit));
            if text[..body].ends_with('{') {
                format!("{}\n{unit}{entry}\n{}", &text[..body], &text[close..])
            } else {
                format!("{},\n{unit}{entry}{}", &text[..body], &text[body..])
            }
        }
    }
}

fn leading_space(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

/// `v` printed one level in, `indent` deep: the file's own indent unit, so the
/// new block reads as the rest of the file does.
fn pretty(v: &Value, indent: &str) -> String {
    let unit = if indent.is_empty() { "  " } else { indent };
    // serde_json indents by two spaces; a string never holds a raw newline,
    // so a line's leading spaces are all indent.
    let s = serde_json::to_string_pretty(v).expect("a Value serializes");
    let lines: Vec<String> = s
        .lines()
        .enumerate()
        .map(|(i, line)| {
            let body = line.trim_start_matches(' ');
            let depth = (line.len() - body.len()) / 2;
            let base = if i == 0 { "" } else { indent };
            format!("{base}{}{body}", unit.repeat(depth))
        })
        .collect();
    lines.join("\n")
}

/// Replaces `file` whole, through a temporary file beside it renamed over it,
/// keeping its permissions.
fn write(file: &Path, text: &str) -> Result<(), String> {
    let name = file
        .file_name()
        .map_or("settings".into(), |n| n.to_string_lossy());
    let tmp = file.with_file_name(format!(".{name}.hooky-{}", std::process::id()));
    let err = |e: std::io::Error| format!("writing {}: {e}", file.display());
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(&tmp, text).map_err(err)?;
    if let Ok(meta) = fs::metadata(file) {
        fs::set_permissions(&tmp, meta.permissions()).map_err(err)?;
    }
    fs::rename(&tmp, file).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        err(e)
    })
}

fn changes(old: &Value, new: &Value) -> Vec<String> {
    let empty = Map::new();
    let old = old.as_object().unwrap_or(&empty);
    let new = new.as_object().unwrap_or(&empty);
    let mut lines = Vec::new();
    for (event, v) in new {
        match old.get(event) {
            None => lines.push(format!("{event}: added")),
            Some(o) if o != v => lines.push(format!("{event}: changed")),
            Some(_) => {}
        }
    }
    for event in old.keys().filter(|e| !new.contains_key(*e)) {
        lines.push(format!("{event}: removed"));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hooky_commands_are_told_from_others() {
        assert!(calls_hooky("~/.local/bin/hooky PreToolUse", "PreToolUse"));
        assert!(calls_hooky("/opt/hooky --harness codex Stop", "Stop"));
        assert!(calls_hooky("~/'my apps/hooky' Stop", "Stop"));
        assert!(calls_hooky("hooky Stop", "Stop"));
        assert!(!calls_hooky("/opt/hooky Stop", "PreToolUse"));
        assert!(!calls_hooky("bash ~/.claude/hooks/router Stop", "Stop"));
        assert!(!calls_hooky(
            "~/.local/bin/trinket-git-message",
            "PreToolUse"
        ));
        assert!(!calls_hooky("python3 /opt/hooky Stop", "Stop"));
    }

    #[test]
    fn an_entry_install_writes_is_its_own_whatever_the_binary_is_called() {
        let new = json!({"Stop": [{"hooks": [
            {"type": "command", "command": "/opt/hook-router Stop"}
        ]}]});
        assert!(foreign_hooks(&new, &new).is_empty());
        let other = json!({"Stop": [{"hooks": [
            {"type": "command", "command": "/opt/hook-router Stop", "timeout": 5}
        ]}]});
        assert_eq!(foreign_hooks(&other, &new), ["Stop: /opt/hook-router Stop"]);
    }

    #[test]
    fn a_minified_file_keeps_its_other_keys() {
        let text = r#"{"a":1,"hooks":{"Stop":[]},"b":2}"#;
        let top: BTreeMap<String, &RawValue> = serde_json::from_str(text).unwrap();
        let out = splice(text, top.get("hooks").copied(), &json!({}));
        assert_eq!(out, r#"{"a":1,"hooks":{},"b":2}"#);
    }
}
