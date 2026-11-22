//! The hooks file hooky reads, the state file that switches handlers off, and
//! the choice of handlers for one event.
//!
//! The hooks file is Claude Code's own `{"hooks": {...}}` shape, so pasting its
//! entries back into settings.json undoes hooky, and a whole settings.json
//! loads as one: hooky ignores every top-level key except `hooks` and `hooky`.

use std::collections::HashSet;
use std::path::Path;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::event::{self, MatchOn};
use crate::guards::{self, Guard};
use crate::harness::Harness;

#[derive(Debug, Clone)]
pub struct Config {
    /// Events in file order, each with its matcher groups in file order.
    pub events: Vec<(String, Vec<Group>)>,
    pub log: LogSettings,
    /// `hooky.builtins`: handler command → in-process guard name.
    pub builtins: Vec<(String, String)>,
    /// Problems worth a log note that do not stop hooky.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Group {
    /// The matcher as written; empty when the group sets none.
    pub matcher: String,
    pub handlers: Vec<Handler>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Handler {
    pub command: String,
    /// Seconds, as written; `None` takes the event's default.
    pub timeout: Option<f64>,
    pub is_async: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogSettings {
    /// Day files older than this many days are deleted. 0 keeps them all.
    pub retention_days: u32,
    /// Longest tool input or prompt text a log line keeps.
    pub max_input_chars: usize,
    /// Longest stdout or stderr per handler a log line keeps.
    pub max_output_chars: usize,
}

impl Default for LogSettings {
    fn default() -> Self {
        LogSettings {
            retention_days: 30,
            max_input_chars: 500,
            max_output_chars: 2000,
        }
    }
}

/// A handler's identity: the Handlers view and `state.json` name it by event,
/// matcher and command, since one command can serve several events.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HandlerId {
    pub event: String,
    pub matcher: String,
    pub command: String,
}

impl HandlerId {
    pub fn to_json(&self) -> Value {
        json!({"event": self.event, "matcher": self.matcher, "command": self.command})
    }
}

#[derive(Debug, Clone)]
pub struct Selected {
    pub id: HandlerId,
    pub handler: Handler,
    /// The guard that answers in-process instead of the command.
    pub builtin: Option<&'static Guard>,
}

impl Selected {
    pub fn timeout(&self) -> f64 {
        self.handler
            .timeout
            .unwrap_or_else(|| event::default_timeout(&self.id.event))
    }
}

pub fn load(path: &Path) -> Result<Config, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn parse(text: &str) -> Result<Config, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let root = root.as_object().ok_or("the top level is not an object")?;
    let mut events = Vec::new();
    if let Some(hooks) = root.get("hooks") {
        let hooks = hooks.as_object().ok_or("`hooks` is not an object")?;
        for (name, groups) in hooks {
            let groups = groups
                .as_array()
                .ok_or_else(|| format!("hooks.{name} is not an array"))?;
            let groups = groups
                .iter()
                .enumerate()
                .map(|(i, g)| parse_group(g, &format!("hooks.{name}[{i}]")))
                .collect::<Result<Vec<_>, _>>()?;
            events.push((name.clone(), groups));
        }
    }
    let log = match root.get("hooky").and_then(|r| r.get("log")) {
        None => LogSettings::default(),
        Some(v) => parse_log(v)?,
    };
    let mut builtins = Vec::new();
    let mut notes = Vec::new();
    if let Some(map) = root.get("hooky").and_then(|r| r.get("builtins")) {
        let map = map.as_object().ok_or("hooky.builtins is not an object")?;
        for (command, name) in map {
            let name = name.as_str().ok_or_else(|| {
                format!("hooky.builtins: the value for `{command}` is not a string")
            })?;
            // A guard this binary lacks runs as its command: a hooks file
            // newer than the binary degrades to the script it names.
            if guards::lookup(name).is_none() {
                notes.push(format!(
                    "hooky.builtins: no guard named `{name}`; running `{command}` instead"
                ));
            }
            builtins.push((command.clone(), name.to_string()));
        }
    }
    Ok(Config {
        events,
        log,
        builtins,
        notes,
    })
}

fn parse_group(v: &Value, at: &str) -> Result<Group, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| format!("{at} is not an object"))?;
    let mut matcher = String::new();
    let mut handlers = None;
    for (key, value) in obj {
        match key.as_str() {
            "matcher" => {
                matcher = value
                    .as_str()
                    .ok_or_else(|| format!("{at}.matcher is not a string"))?
                    .to_string();
            }
            "hooks" => {
                let list = value
                    .as_array()
                    .ok_or_else(|| format!("{at}.hooks is not an array"))?;
                handlers = Some(
                    list.iter()
                        .enumerate()
                        .map(|(i, h)| parse_handler(h, &format!("{at}.hooks[{i}]")))
                        .collect::<Result<Vec<_>, _>>()?,
                );
            }
            other => return Err(format!("{at}: hooky does not support the field `{other}`")),
        }
    }
    let handlers = handlers.ok_or_else(|| format!("{at} has no `hooks` list"))?;
    Ok(Group { matcher, handlers })
}

/// Fields hooky honours, and fields that change nothing for it. Any other field
/// is refused: running a handler without the filter or failure rule its entry
/// asks for would change what the entry does.
fn parse_handler(v: &Value, at: &str) -> Result<Handler, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| format!("{at} is not an object"))?;
    let mut command = None;
    let mut timeout = None;
    let mut is_async = false;
    for (key, value) in obj {
        match key.as_str() {
            "type" => {
                if value.as_str() != Some("command") {
                    return Err(format!(
                        "{at}: hooky runs only `type: \"command\"` handlers"
                    ));
                }
            }
            "command" => {
                let c = value
                    .as_str()
                    .ok_or_else(|| format!("{at}.command is not a string"))?;
                if c.trim().is_empty() {
                    return Err(format!("{at}.command is empty"));
                }
                command = Some(c.to_string());
            }
            "timeout" => {
                let t = value
                    .as_f64()
                    .filter(|t| *t > 0.0)
                    .ok_or_else(|| format!("{at}.timeout is not a positive number"))?;
                timeout = Some(t);
            }
            "async" => {
                is_async = value
                    .as_bool()
                    .ok_or_else(|| format!("{at}.async is not a boolean"))?;
            }
            "shell" => {
                if value.as_str() != Some("bash") {
                    return Err(format!(
                        "{at}: hooky runs commands only with `shell: \"bash\"`"
                    ));
                }
            }
            // A spinner label, and a field Claude Code ignores outside skills.
            "statusMessage" | "once" => {}
            other => return Err(format!("{at}: hooky does not support the field `{other}`")),
        }
    }
    if !obj.contains_key("type") {
        return Err(format!("{at} has no `type`"));
    }
    let command = command.ok_or_else(|| format!("{at} has no `command`"))?;
    Ok(Handler {
        command,
        timeout,
        is_async,
    })
}

fn parse_log(v: &Value) -> Result<LogSettings, String> {
    let obj = v.as_object().ok_or("hooky.log is not an object")?;
    let mut s = LogSettings::default();
    for (key, value) in obj {
        let n = value
            .as_u64()
            .ok_or_else(|| format!("hooky.log.{key} is not a whole number"))?;
        match key.as_str() {
            "retention_days" => s.retention_days = n as u32,
            "max_input_chars" => s.max_input_chars = n as usize,
            "max_output_chars" => s.max_output_chars = n as usize,
            other => return Err(format!("hooky.log: unknown field `{other}`")),
        }
    }
    Ok(s)
}

/// A matcher compiled by Claude Code's rules: match-all, an exact list, or an
/// unanchored regex.
#[derive(Debug)]
pub enum Matcher {
    All,
    Exact(Vec<String>),
    Regex(Regex),
}

impl Matcher {
    pub fn compile(matcher: &str, event: &str) -> Result<Matcher, String> {
        if matcher.is_empty() || matcher == "*" {
            return Ok(Matcher::All);
        }
        let narrow = event::narrow_exact(event);
        let exact = matcher.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || c == '_'
                || c == '|'
                || (!narrow && matches!(c, '-' | ' ' | ','))
        });
        if exact {
            let names = matcher
                .split(|c| c == '|' || (!narrow && c == ','))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect();
            return Ok(Matcher::Exact(names));
        }
        Regex::new(matcher)
            .map(Matcher::Regex)
            .map_err(|e| format!("matcher `{matcher}` on {event}: {e}"))
    }

    pub fn matches(&self, value: &str) -> bool {
        match self {
            Matcher::All => true,
            Matcher::Exact(names) => names.iter().any(|n| n == value),
            Matcher::Regex(re) => re.is_match(value),
        }
    }

    /// The exact names this matcher accepts, when it accepts a finite list.
    /// An anchored alternation of plain names such as `^(Write|Edit)$` counts.
    fn names(&self, written: &str) -> Option<Vec<String>> {
        match self {
            Matcher::All => None,
            Matcher::Exact(names) => Some(names.clone()),
            Matcher::Regex(_) => {
                let inner = written.strip_prefix('^')?.strip_suffix('$')?;
                let inner = inner
                    .strip_prefix('(')
                    .and_then(|s| s.strip_suffix(')'))
                    .unwrap_or(inner);
                let plain = !inner.is_empty()
                    && inner
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '|');
                plain.then(|| {
                    inner
                        .split('|')
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                })
            }
        }
    }
}

/// Handlers switched off by `state.json`, which the future Rune app owns.
#[derive(Debug, Default)]
pub struct Disabled(HashSet<HandlerId>);

impl Disabled {
    pub fn contains(&self, id: &HandlerId) -> bool {
        self.0.contains(id)
    }
}

/// Reads `{"disabled": [{"event", "matcher", "command"}]}`. A missing file
/// disables nothing. So does a corrupt one, which also returns a note for the
/// log: a broken state file must not take the guards down with it.
pub fn load_state(path: &Path) -> (Disabled, Option<String>) {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (Disabled::default(), None),
        Err(e) => {
            return (
                Disabled::default(),
                Some(format!("state {}: {e}", path.display())),
            );
        }
    };
    match parse_state(&text) {
        Ok(d) => (d, None),
        Err(e) => (
            Disabled::default(),
            Some(format!("state {}: {e}; nothing disabled", path.display())),
        ),
    }
}

fn parse_state(text: &str) -> Result<Disabled, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let mut set = HashSet::new();
    let Some(list) = root.get("disabled") else {
        return Ok(Disabled(set));
    };
    for entry in list.as_array().ok_or("`disabled` is not an array")? {
        let field = |k: &str| {
            entry
                .get(k)
                .and_then(Value::as_str)
                .map(String::from)
                .ok_or_else(|| format!("a `disabled` entry has no string `{k}`"))
        };
        set.insert(HandlerId {
            event: field("event")?,
            matcher: entry
                .get("matcher")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            command: field("command")?,
        });
    }
    Ok(Disabled(set))
}

/// The handlers Claude Code would run for this event, and the ones state.json
/// switched off. Identical commands run once, as Claude Code runs them once.
pub fn select(
    cfg: &Config,
    event: &str,
    input: &Value,
    disabled: &Disabled,
) -> Result<(Vec<Selected>, Vec<HandlerId>), String> {
    let Some((_, groups)) = cfg.events.iter().find(|(name, _)| name == event) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let target = match event::match_on(event) {
        MatchOn::Field(f) => Some(input.get(f).and_then(Value::as_str).unwrap_or("")),
        MatchOn::Ignored => None,
        MatchOn::Unknown => {
            if let Some(g) = groups
                .iter()
                .find(|g| !matches!(g.matcher.as_str(), "" | "*"))
            {
                return Err(format!(
                    "hooky does not know which input field {event} matchers test, so it cannot apply `{}`",
                    g.matcher
                ));
            }
            None
        }
    };
    let mut selected: Vec<Selected> = Vec::new();
    let mut skipped = Vec::new();
    for group in groups {
        if let Some(value) = target
            && !Matcher::compile(&group.matcher, event)?.matches(value)
        {
            continue;
        }
        for handler in &group.handlers {
            let id = HandlerId {
                event: event.to_string(),
                matcher: group.matcher.clone(),
                command: handler.command.clone(),
            };
            if disabled.contains(&id) {
                skipped.push(id);
                continue;
            }
            let duplicate = selected.iter().any(|s| {
                s.handler.command == handler.command && s.handler.is_async == handler.is_async
            });
            if !duplicate {
                // An async handler's answer is dropped, so it stays a process.
                let builtin = (!handler.is_async)
                    .then(|| cfg.builtins.iter().find(|(c, _)| *c == handler.command))
                    .flatten()
                    .and_then(|(_, name)| guards::lookup(name));
                selected.push(Selected {
                    id,
                    handler: handler.clone(),
                    builtin,
                });
            }
        }
    }
    Ok((selected, skipped))
}

/// The `hooks` block that hands every configured event to hooky: one entry
/// per event, calling `<bin> <Event>`, or `<bin> --harness codex <Event>` in
/// Codex's settings.
///
/// - **matcher**: on events with matcher support, the union of the groups'
///   names. Claude Code then starts hooky only when some handler can match,
///   and keeps its own Bash-matcher handling of Monitor commands. A group that
///   matches all, or whose regex is not a plain list, drops the matcher.
/// - **timeout**: the largest handler timeout plus a 2-second margin, so hooky
///   kills a slow handler and answers before Claude Code kills hooky.
/// - **async**: set when every handler of the event is async.
pub fn settings_block(
    cfg: &Config,
    bin: &str,
    harness: Harness,
) -> Result<(Value, Vec<String>), String> {
    let mut hooks = Map::new();
    let mut warnings = Vec::new();
    let bin = match harness.flag() {
        Some(flag) => format!("{} {flag}", shell_word(bin)),
        None => shell_word(bin),
    };
    for (event, groups) in &cfg.events {
        let handlers: Vec<&Handler> = groups.iter().flat_map(|g| &g.handlers).collect();
        if handlers.is_empty() {
            continue;
        }
        let mut entry = Map::new();
        if let MatchOn::Field(_) | MatchOn::Unknown = event::match_on(event) {
            match union_matcher(groups, event)? {
                Some(m) => {
                    entry.insert("matcher".into(), Value::String(m));
                }
                None => {
                    if groups
                        .iter()
                        .any(|g| !matches!(g.matcher.as_str(), "" | "*"))
                    {
                        warnings.push(format!(
                            "{event}: a matcher is not a plain list of names, so hooky runs on every {event}"
                        ));
                    }
                }
            }
        }
        let mut hook = Map::new();
        hook.insert("type".into(), "command".into());
        hook.insert("command".into(), Value::String(format!("{bin} {event}")));
        let sync_max = handlers
            .iter()
            .filter(|h| !h.is_async)
            .map(|h| h.timeout.unwrap_or_else(|| event::default_timeout(event)))
            .fold(None, |acc: Option<f64>, t| {
                Some(acc.map_or(t, |a| a.max(t)))
            });
        match sync_max {
            Some(t) => {
                hook.insert("timeout".into(), json!(t.ceil() as u64 + 2));
                // hooky itself fails closed on these events; onFailure covers
                // the one case it cannot, a hooky that never starts. Claude
                // Code before 2.1.295 ignores the field; Codex has none.
                if event::fails_closed(event) && harness.blocks_on_failure() {
                    hook.insert("onFailure".into(), "block".into());
                }
            }
            None => {
                hook.insert("async".into(), Value::Bool(true));
            }
        }
        entry.insert("hooks".into(), Value::Array(vec![Value::Object(hook)]));
        hooks.insert(event.clone(), Value::Array(vec![Value::Object(entry)]));
    }
    Ok((json!({ "hooks": hooks }), warnings))
}

fn union_matcher(groups: &[Group], event: &str) -> Result<Option<String>, String> {
    let mut names: Vec<String> = Vec::new();
    for g in groups {
        let m = Matcher::compile(&g.matcher, event)?;
        let Some(list) = m.names(&g.matcher) else {
            return Ok(None);
        };
        for n in list {
            if !names.contains(&n) {
                names.push(n);
            }
        }
    }
    Ok((!names.is_empty()).then(|| names.join("|")))
}

/// Single-quotes a path for the shell unless every character is safe bare.
/// A leading `~/` stays bare so the shell still expands it, as it does for the
/// `~/.claude/hooks/...` commands already in settings.json.
fn shell_word(s: &str) -> String {
    let (tilde, rest) = match s.strip_prefix("~/") {
        Some(rest) => ("~/", rest),
        None => ("", s),
    };
    if rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c))
    {
        s.to_string()
    } else {
        format!("{tilde}'{}'", rest.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "permissions": {"allow": ["Read"]},
      "hooks": {
        "PreToolUse": [
          {"matcher": "Bash", "hooks": [
            {"type": "command", "command": "guard-a"},
            {"type": "command", "command": "guard-b", "timeout": 120}
          ]},
          {"matcher": "Read", "hooks": [{"type": "command", "command": "read-guard"}]},
          {"matcher": "^(WebSearch|WebFetch)$", "hooks": [{"type": "command", "command": "web"}]},
          {"matcher": "^Bash$", "hooks": [
            {"type": "command", "command": "guard-a"},
            {"type": "command", "command": "late", "timeout": 30}
          ]}
        ],
        "Stop": [{"hooks": [
          {"type": "command", "command": "sound", "timeout": 5, "async": true},
          {"type": "command", "command": "verify", "timeout": 120}
        ]}],
        "Notification": [{"hooks": [{"type": "command", "command": "sound", "async": true}]}]
      }
    }"#;

    fn pre(tool: &str) -> Value {
        json!({"hook_event_name": "PreToolUse", "tool_name": tool})
    }

    fn commands(sel: &[Selected]) -> Vec<&str> {
        sel.iter().map(|s| s.handler.command.as_str()).collect()
    }

    #[test]
    fn a_whole_settings_file_loads() {
        let cfg = parse(SAMPLE).unwrap();
        assert_eq!(cfg.events.len(), 3);
        assert_eq!(cfg.log, LogSettings::default());
    }

    #[test]
    fn matchers_follow_claude_codes_three_forms() {
        let m = |s| Matcher::compile(s, "PreToolUse").unwrap();
        assert!(m("").matches("Anything"));
        assert!(m("*").matches("Anything"));
        assert!(m("Bash").matches("Bash"));
        assert!(!m("Bash").matches("BashOutput"));
        assert!(m("Edit|Write").matches("Write"));
        assert!(m("Edit, Write").matches("Write"));
        // Unanchored regex: `Edit.*` also matches NotebookEdit.
        assert!(m("Edit.*").matches("NotebookEdit"));
        assert!(m("^Bash$").matches("Bash"));
        assert!(!m("^Bash$").matches("BashOutput"));
        // On FileChanged a hyphen sends the matcher down the regex path.
        let f = Matcher::compile("a-b", "FileChanged").unwrap();
        assert!(matches!(f, Matcher::Regex(_)));
    }

    #[test]
    fn bash_runs_both_bash_groups_once_per_command() {
        let cfg = parse(SAMPLE).unwrap();
        let (sel, skipped) =
            select(&cfg, "PreToolUse", &pre("Bash"), &Disabled::default()).unwrap();
        assert_eq!(commands(&sel), ["guard-a", "guard-b", "late"]);
        assert!(skipped.is_empty());
        let (sel, _) = select(&cfg, "PreToolUse", &pre("WebFetch"), &Disabled::default()).unwrap();
        assert_eq!(commands(&sel), ["web"]);
        let (sel, _) = select(&cfg, "PreToolUse", &pre("Edit"), &Disabled::default()).unwrap();
        assert!(sel.is_empty());
    }

    #[test]
    fn events_without_matcher_support_run_every_group() {
        let cfg = parse(SAMPLE).unwrap();
        let input = json!({"hook_event_name": "Stop"});
        let (sel, _) = select(&cfg, "Stop", &input, &Disabled::default()).unwrap();
        assert_eq!(commands(&sel), ["sound", "verify"]);
        assert!(sel[0].handler.is_async);
    }

    #[test]
    fn state_switches_a_handler_off_by_event_matcher_and_command() {
        let cfg = parse(SAMPLE).unwrap();
        let disabled = parse_state(
            r#"{"disabled": [{"event": "PreToolUse", "matcher": "Bash", "command": "guard-b"}]}"#,
        )
        .unwrap();
        let (sel, skipped) = select(&cfg, "PreToolUse", &pre("Bash"), &disabled).unwrap();
        assert_eq!(commands(&sel), ["guard-a", "late"]);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].command, "guard-b");
    }

    #[test]
    fn a_corrupt_state_file_disables_nothing_and_says_so() {
        let dir = std::env::temp_dir().join(format!("hooky-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        std::fs::write(&path, "{not json").unwrap();
        let (d, note) = load_state(&path);
        assert!(d.0.is_empty());
        assert!(note.unwrap().contains("nothing disabled"));
        let (d, note) = load_state(&dir.join("missing.json"));
        assert!(d.0.is_empty() && note.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unsupported_fields_are_refused() {
        for (field, value) in [
            ("if", r#""Bash(git *)""#),
            ("args", "[]"),
            ("asyncRewake", "true"),
            ("onFailure", r#""block""#),
        ] {
            let text = format!(
                r#"{{"hooks": {{"PreToolUse": [{{"hooks": [{{"type": "command", "command": "x", "{field}": {value}}}]}}]}}}}"#
            );
            let err = parse(&text).unwrap_err();
            assert!(err.contains(field), "{err}");
        }
        let prompt = r#"{"hooks": {"Stop": [{"hooks": [{"type": "prompt", "prompt": "x"}]}]}}"#;
        assert!(parse(prompt).unwrap_err().contains("command"));
    }

    #[test]
    fn a_matcher_on_an_event_hooky_cannot_match_is_refused() {
        let cfg = parse(r#"{"hooks": {"Elicitation": [{"matcher": "srv", "hooks": [{"type": "command", "command": "x"}]}]}}"#)
            .unwrap();
        let err = select(&cfg, "Elicitation", &json!({}), &Disabled::default()).unwrap_err();
        assert!(err.contains("Elicitation"));
    }

    #[test]
    fn log_settings_come_from_the_hooky_key() {
        let cfg =
            parse(r#"{"hooky": {"log": {"retention_days": 7, "max_input_chars": 80}}}"#).unwrap();
        assert_eq!(cfg.log.retention_days, 7);
        assert_eq!(cfg.log.max_input_chars, 80);
        assert_eq!(cfg.log.max_output_chars, 2000);
    }

    #[test]
    fn settings_block_hands_each_event_to_hooky() {
        let cfg = parse(SAMPLE).unwrap();
        assert_eq!(shell_word("~/.local/bin/hooky"), "~/.local/bin/hooky");
        assert_eq!(shell_word("~/my tools/hooky"), "~/'my tools/hooky'");
        assert_eq!(shell_word("/opt/it's/hooky"), r"'/opt/it'\''s/hooky'");
        let (block, warnings) = settings_block(&cfg, "/bin/hooky", Harness::Claude).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(
            block,
            json!({"hooks": {
                "PreToolUse": [{"matcher": "Bash|Read|WebSearch|WebFetch", "hooks": [
                    {"type": "command", "command": "/bin/hooky PreToolUse", "timeout": 602,
                        "onFailure": "block"}
                ]}],
                "Stop": [{"hooks": [
                    {"type": "command", "command": "/bin/hooky Stop", "timeout": 122}
                ]}],
                "Notification": [{"hooks": [
                    {"type": "command", "command": "/bin/hooky Notification", "async": true}
                ]}]
            }})
        );
    }

    #[test]
    fn a_regex_matcher_that_is_not_a_list_drops_the_union() {
        let cfg = parse(
            r#"{"hooks": {"PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": "a"}]},
            {"matcher": "mcp__.*", "hooks": [{"type": "command", "command": "b"}]}
        ]}}"#,
        )
        .unwrap();
        let (block, warnings) = settings_block(&cfg, "hooky", Harness::Claude).unwrap();
        assert!(block["hooks"]["PreToolUse"][0].get("matcher").is_none());
        assert_eq!(warnings.len(), 1);
    }
}
