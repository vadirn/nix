//! The hooks file as the Handlers screen lists it, and `state.json`, the
//! toggles file route reads on every event: the one file of route's this app
//! writes.
//!
//! A handler's toggle key is route's (`route/src/config.rs`, `HandlerId`): its
//! event, its group's matcher as written (`""` for a group with none), and its
//! command. A built-in guard keeps its script command in the hooks file, and
//! `route.builtins` maps that command to the guard, so one key serves both
//! (`config::select` skips a disabled id before it looks for a builtin).
//!
//! The hooks file is hand-edited and never written here. `state.json` is
//! written whole, to a temporary file renamed over it, so route never reads a
//! half-written file; each change re-reads it first, so an edit made elsewhere
//! since the last look is kept.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::Path;

use serde_json::{Map, Value, json};

/// One handler as the hooks file lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub command: String,
    /// Seconds, as written; `None` takes the event's default.
    pub timeout: Option<f64>,
    pub is_async: bool,
}

/// A matcher group: the handlers one matcher picks.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    /// The matcher as written; empty when the group sets none.
    pub matcher: String,
    pub handlers: Vec<Entry>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Hooks {
    /// Events in file order, each with its groups in file order.
    pub events: Vec<(String, Vec<Group>)>,
    /// `route.builtins`: the commands route answers in-process.
    pub builtins: Vec<String>,
}

/// A handler's toggle key, as route keys `state.json`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HandlerId {
    pub event: String,
    pub matcher: String,
    pub command: String,
}

impl HandlerId {
    pub fn new(event: &str, matcher: &str, command: &str) -> HandlerId {
        HandlerId {
            event: event.to_string(),
            matcher: matcher.to_string(),
            command: command.to_string(),
        }
    }
}

impl Hooks {
    /// The hooks file's handlers. A viewer, not route: an entry route would
    /// refuse is listed as far as it reads, and anything unreadable is left
    /// out rather than failing the screen.
    pub fn of(root: Option<&Value>) -> Hooks {
        let Some(root) = root else {
            return Hooks::default();
        };
        let entry = |h: &Value| {
            Some(Entry {
                command: h.get("command")?.as_str()?.to_string(),
                timeout: h.get("timeout").and_then(Value::as_f64),
                is_async: h.get("async").and_then(Value::as_bool).unwrap_or(false),
            })
        };
        let group = |g: &Value| Group {
            matcher: g
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            handlers: g
                .get("hooks")
                .and_then(Value::as_array)
                .map(|hs| hs.iter().filter_map(entry).collect())
                .unwrap_or_default(),
        };
        let events = root
            .get("hooks")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(name, gs)| {
                        let gs = gs.as_array().map(|a| a.iter().map(group).collect());
                        (name.clone(), gs.unwrap_or_default())
                    })
                    .collect()
            })
            .unwrap_or_default();
        let builtins = root
            .pointer("/route/builtins")
            .and_then(Value::as_object)
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        Hooks { events, builtins }
    }

    pub fn groups(&self, event: &str) -> &[Group] {
        self.events
            .iter()
            .find(|(name, _)| name == event)
            .map_or(&[], |(_, gs)| gs.as_slice())
    }

    /// Every handler's key, in file order.
    pub fn ids(&self) -> impl Iterator<Item = HandlerId> + '_ {
        self.events.iter().flat_map(|(event, groups)| {
            groups.iter().flat_map(move |g| {
                g.handlers
                    .iter()
                    .map(move |h| HandlerId::new(event, &g.matcher, &h.command))
            })
        })
    }

    /// Whether route answers this handler in-process. An async handler stays
    /// a process even when its command is listed, as route runs it.
    pub fn is_builtin(&self, h: &Entry) -> bool {
        !h.is_async && self.builtins.contains(&h.command)
    }
}

/// `state.json`: `{"disabled": [{"event", "matcher", "command"}]}`, and any
/// other key it holds, kept as it was.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Toggles {
    disabled: Vec<HandlerId>,
    rest: Map<String, Value>,
}

impl Toggles {
    /// Reads the file as route does (`config::parse_state`), but refuses what
    /// route would read as nothing disabled, so a write never replaces a file
    /// it could not read without saying so.
    pub fn parse(text: &str) -> Result<Toggles, String> {
        let root: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
        let Value::Object(mut rest) = root else {
            return Err("the top level is not an object".into());
        };
        let mut disabled = Vec::new();
        if let Some(list) = rest.remove("disabled") {
            for entry in list.as_array().ok_or("`disabled` is not an array")? {
                let field = |k: &str| {
                    entry
                        .get(k)
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("a `disabled` entry has no string `{k}`"))
                };
                let matcher = entry.get("matcher").and_then(Value::as_str).unwrap_or("");
                let id = HandlerId::new(field("event")?, matcher, field("command")?);
                if !disabled.contains(&id) {
                    disabled.push(id);
                }
            }
        }
        Ok(Toggles { disabled, rest })
    }

    /// A missing file disables nothing.
    pub fn load(path: &Path) -> Result<Toggles, String> {
        match fs::read_to_string(path) {
            Ok(text) => Toggles::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Toggles::default()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    pub fn disabled(&self) -> &[HandlerId] {
        &self.disabled
    }

    pub fn is_off(&self, id: &HandlerId) -> bool {
        self.disabled.contains(id)
    }

    pub fn set(&mut self, id: &HandlerId, on: bool) {
        self.disabled.retain(|d| d != id);
        if !on {
            self.disabled.push(id.clone());
        }
    }

    /// Every handler back on, those the hooks file no longer lists included.
    pub fn clear(&mut self) {
        self.disabled.clear();
    }

    /// The switched-off handlers the hooks file still lists. An entry for a
    /// handler since removed from it switches nothing off, so it is not
    /// counted, though "Enable all" clears it.
    pub fn off_in(&self, hooks: &Hooks) -> usize {
        hooks.ids().filter(|id| self.is_off(id)).count()
    }

    pub fn to_json(&self) -> String {
        let mut root = Map::new();
        let list: Vec<Value> = self
            .disabled
            .iter()
            .map(|d| json!({"event": d.event, "matcher": d.matcher, "command": d.command}))
            .collect();
        root.insert("disabled".into(), Value::Array(list));
        root.extend(self.rest.clone());
        let mut text = serde_json::to_string_pretty(&Value::Object(root)).expect("serializes");
        text.push('\n');
        text
    }

    /// Writes the file whole: a temporary file beside it, flushed to disk,
    /// then renamed over it, so route reads the old file or the new one and
    /// never a part. Private, as route's own files are.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let dir = path.parent().ok_or("state.json has no directory")?;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
        let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let written = (|| {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(self.to_json().as_bytes())?;
            f.sync_all()?;
            fs::rename(&tmp, path)
        })();
        if let Err(e) = written {
            let _ = fs::remove_file(&tmp);
            return Err(format!("{}: {e}", path.display()));
        }
        Ok(())
    }

    /// Re-reads the file, applies `change`, and writes it back. A file that
    /// will not read is replaced, and the error says so: route already reads
    /// it as nothing disabled.
    pub fn update(path: &Path, change: impl FnOnce(&mut Toggles)) -> (Toggles, Option<String>) {
        let (mut t, note) = match Toggles::load(path) {
            Ok(t) => (t, None),
            Err(e) => (Toggles::default(), Some(format!("{e}; replaced"))),
        };
        change(&mut t);
        let error = t.save(path).err().or(note);
        (t, error)
    }
}

/// `30` reads `30 s`, `1.5` reads `1.5 s`.
pub fn seconds(t: f64) -> String {
    if t.fract() == 0.0 {
        format!("{} s", t as u64)
    } else {
        format!("{t} s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOOKS: &str = r#"{
      "route": {"builtins": {"guard-a": "a", "sound": "s"}},
      "hooks": {
        "PreToolUse": [
          {"matcher": "Bash", "hooks": [
            {"type": "command", "command": "guard-a"},
            {"type": "command", "command": "slow", "timeout": 120}
          ]},
          {"matcher": "^Bash$", "hooks": [{"type": "command", "command": "guard-a"}]}
        ],
        "Stop": [{"hooks": [{"type": "command", "command": "sound", "timeout": 5, "async": true}]}]
      }
    }"#;

    fn hooks() -> Hooks {
        Hooks::of(Some(&serde_json::from_str(HOOKS).unwrap()))
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("rc-toggles-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn handlers_list_by_event_and_matcher_as_written() {
        let h = hooks();
        let pre = h.groups("PreToolUse");
        assert_eq!(pre.len(), 2);
        assert_eq!(pre[0].matcher, "Bash");
        assert_eq!(pre[0].handlers[1].timeout, Some(120.0));
        assert_eq!(
            h.groups("Stop")[0].matcher,
            "",
            "no matcher is the empty one"
        );
        assert!(h.groups("Nope").is_empty());
        let ids: Vec<HandlerId> = h.ids().collect();
        assert_eq!(ids.len(), 4);
        assert_eq!(
            ids[2],
            HandlerId::new("PreToolUse", "^Bash$", "guard-a"),
            "one command under two matchers is two handlers"
        );
        assert!(h.is_builtin(&pre[0].handlers[0]));
        assert!(
            !h.is_builtin(&h.groups("Stop")[0].handlers[0]),
            "async stays a process"
        );
    }

    #[test]
    fn a_toggle_writes_route_s_shape_and_keeps_other_keys() {
        let mut t = Toggles::parse(r#"{"note": "mine", "disabled": []}"#).unwrap();
        let id = HandlerId::new("PreToolUse", "Bash", "slow");
        t.set(&id, false);
        t.set(&id, false);
        assert_eq!(t.disabled().len(), 1, "switching off twice keeps one entry");
        let v: Value = serde_json::from_str(&t.to_json()).unwrap();
        assert_eq!(
            v,
            json!({"disabled": [{"event": "PreToolUse", "matcher": "Bash", "command": "slow"}],
                "note": "mine"})
        );
        assert_eq!(t.off_in(&hooks()), 1);
        t.set(&id, true);
        assert!(!t.is_off(&id));
    }

    #[test]
    fn enable_all_clears_entries_the_hooks_file_dropped() {
        let mut t = Toggles::parse(
            r#"{"disabled": [{"event": "Stop", "matcher": "", "command": "gone"},
                {"event": "Stop", "command": "sound"}]}"#,
        )
        .unwrap();
        assert!(
            t.is_off(&HandlerId::new("Stop", "", "sound")),
            "no matcher reads as empty"
        );
        assert_eq!(t.off_in(&hooks()), 1, "a dropped handler is not counted");
        t.clear();
        assert!(t.disabled().is_empty());
    }

    #[test]
    fn a_file_route_would_ignore_is_refused_not_silently_emptied() {
        assert!(Toggles::parse("{nope").is_err());
        assert!(Toggles::parse("[]").is_err());
        assert!(Toggles::parse(r#"{"disabled": [{"event": "Stop"}]}"#).is_err());
    }

    #[test]
    fn saving_replaces_the_file_whole_and_privately() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("save");
        let path = dir.join("route/state.json");
        assert_eq!(
            Toggles::load(&path).unwrap(),
            Toggles::default(),
            "missing is empty"
        );
        let id = HandlerId::new("PreToolUse", "Bash", "slow");
        let (t, err) = Toggles::update(&path, |t| t.set(&id, false));
        assert!(err.is_none(), "{err:?}");
        assert!(t.is_off(&id));
        assert_eq!(Toggles::load(&path).unwrap(), t);
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["state.json"], "no temporary file is left");
        fs::write(&path, "{broken").unwrap();
        let (t, err) = Toggles::update(&path, |t| t.set(&id, false));
        assert!(
            err.unwrap().contains("replaced"),
            "a broken file is replaced, and said so"
        );
        assert_eq!(Toggles::load(&path).unwrap(), t);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_update_keeps_a_change_made_elsewhere() {
        let dir = scratch("elsewhere");
        let path = dir.join("state.json");
        let a = HandlerId::new("PreToolUse", "Bash", "guard-a");
        let b = HandlerId::new("PreToolUse", "Bash", "slow");
        Toggles::update(&path, |t| t.set(&a, false));
        let (t, _) = Toggles::update(&path, |t| t.set(&b, false));
        assert!(t.is_off(&a) && t.is_off(&b));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn timeouts_read_in_seconds() {
        assert_eq!(seconds(30.0), "30 s");
        assert_eq!(seconds(1.5), "1.5 s");
    }
}
