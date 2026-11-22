//! route: the one hook entry per event, for Claude Code and Codex.
//!
//! The harness's settings call `route [--harness codex] <Event>` with the
//! event JSON on stdin. route picks the handlers that harness's hooks file
//! lists for the event, runs them in parallel, answers once, and appends one
//! JSONL line to the shared log.
//!
//! A failure of route itself (a panic, a bad hooks file, its own deadline)
//! blocks on PreToolUse and lets every other event through: a broken guard
//! path must not silently allow tool calls, and a block on Stop could loop.
//! A failing handler stays a non-blocking error, as Claude Code treats it.
//! Whatever ends route early (a signal, a panic, its deadline) kills the sync
//! handlers still running; async handlers are detached and keep going.

mod config;
mod event;
mod guards;
mod harness;
mod install;
mod log;
mod merge;
mod run;
mod shell;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::exit;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use chrono::{Local, SecondsFormat};
use serde_json::{Value, json};

use config::Selected;
use harness::Harness;
use merge::Answer;

const USAGE: &str = "\
usage: route [--harness NAME] [--config PATH] [--state PATH] [--log-dir PATH] <Event>
       route [--harness NAME] [--config PATH] settings [--bin PATH]
       route [--harness NAME] [--config PATH] install [--bin PATH] [--settings PATH]

  <Event>    run the handlers for one hook event; the event JSON arrives on
             stdin
  settings   print the settings `hooks` block that hands every event in the
             hooks file to route, calling the binary at --bin (default: this
             one, under ~/ when it sits in your home)
  install    write that block into the harness's settings file, replacing
             only its `hooks` value (default ~/.claude/settings.json, or
             ~/.codex/hooks.json for Codex); a hook there that does not call
             route stops it, and so does running from the Nix store without
             --bin

  --harness  claude (default) or codex: picks the default hooks and state
             files, and names the harness in the log
  --config   hooks file, Claude Code's {\"hooks\": ...} shape
             (default ~/.config/route/hooks.json, codex/hooks.json for Codex)
  --state    handlers switched off (default ~/.local/state/route/state.json,
             codex/state.json for Codex)
  --log-dir  per-day JSONL logs, shared (default ~/.local/state/route/log)";

/// How long route waits, after answering, for async handlers to take their
/// payload before it exits and closes their stdin.
const ASYNC_FEED_WAIT: Duration = Duration::from_millis(500);

static EVENT: OnceLock<String> = OnceLock::new();
/// Exit code of the response already written, or -1 before then.
static EMITTED: AtomicI32 = AtomicI32::new(-1);
static EMIT: Mutex<()> = Mutex::new(());

/// Writes the response once. The watchdog and the panic hook race the main
/// thread here, and only the first writer counts.
fn emit(stdout: &[u8], stderr: &[u8], code: i32) {
    let _guard = EMIT.lock().unwrap_or_else(|p| p.into_inner());
    if EMITTED.load(Ordering::SeqCst) >= 0 {
        return;
    }
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(stdout);
    let _ = out.flush();
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(stderr);
    let _ = err.flush();
    EMITTED.store(code, Ordering::SeqCst);
}

/// route itself failed, so the handlers' verdict is unknown. On PreToolUse the
/// call is denied with the failure as the reason; elsewhere it goes ahead with
/// a non-blocking error. If the answer was already written, it stands.
fn fail(msg: &str) -> ! {
    let event = EVENT.get().map(String::as_str).unwrap_or("");
    let code = if event::fails_closed(event) { 2 } else { 1 };
    emit(b"", format!("route: {msg}\n").as_bytes(), code);
    run::kill_running();
    exit(EMITTED.load(Ordering::SeqCst))
}

/// Takes the running handlers down with route, then dies of the same signal.
/// Each handler leads its own process group, so a signal sent to route or to
/// route's group alone would leave them running.
extern "C" fn on_signal(sig: libc::c_int) {
    run::kill_running();
    // SAFETY: signal(2) and raise(3) are async-signal-safe; with the default
    // disposition restored, raise ends the process.
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

fn forward_signals() {
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // SAFETY: installs a handler that only calls async-signal-safe
        // functions. A caught signal reverts to the default in exec'd
        // children, so handlers start with their usual dispositions.
        unsafe {
            libc::signal(
                sig,
                on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
}

struct Paths {
    config: PathBuf,
    state: PathBuf,
    log_dir: PathBuf,
}

enum Cmd {
    Hook(String),
    Settings { bin: String },
    Install { bin: String, settings: PathBuf },
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map_or_else(|| "/".into(), PathBuf::from)
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home().join(fallback),
    }
}

/// This binary's path as a settings entry calls it: written from `~/` when
/// it sits in the home folder, since the entry's shell expands it.
fn own_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot find route's own path: {e}"))?;
    let home = home();
    Ok(match exe.strip_prefix(&home) {
        Ok(rest) if home != std::path::Path::new("/") => format!("~/{}", rest.display()),
        _ => exe.display().to_string(),
    })
}

/// `path`, unless it lies in the Nix store, where `nix run` starts route:
/// the next garbage collection deletes it while the entries install wrote
/// still call it.
fn outlasting(path: String) -> Result<String, String> {
    if path.starts_with("/nix/store/") {
        Err(format!(
            "route runs from the Nix store ({path}), which garbage collection empties; pass --bin with the path the settings should call, such as ~/.local/libexec/route"
        ))
    } else {
        Ok(path)
    }
}

fn looks_like_event(s: &str) -> bool {
    s != "settings"
        && s.starts_with(|c: char| c.is_ascii_uppercase())
        && s.chars().all(|c| c.is_ascii_alphabetic())
}

fn parse_args(args: &[String]) -> Result<(Paths, Harness, Cmd), String> {
    let mut harness = Harness::Claude;
    let (mut config, mut state, mut log_dir) = (None, None, None);
    let (mut bin, mut settings) = (None, None);
    let mut positional = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--harness" => harness = Harness::parse(&value("--harness")?)?,
            "--config" => config = Some(PathBuf::from(value("--config")?)),
            "--state" => state = Some(PathBuf::from(value("--state")?)),
            "--log-dir" => log_dir = Some(PathBuf::from(value("--log-dir")?)),
            "--bin" => bin = Some(value("--bin")?),
            "--settings" => settings = Some(PathBuf::from(value("--settings")?)),
            "-h" | "--help" => return Err(String::new()),
            flag if flag.starts_with('-') => return Err(format!("unknown flag {flag}")),
            word => positional.push(word.to_string()),
        }
    }
    let config_dir = xdg("XDG_CONFIG_HOME", ".config").join("route");
    let state_dir = xdg("XDG_STATE_HOME", ".local/state").join("route");
    let paths = Paths {
        config: config.unwrap_or_else(|| harness.file(&config_dir, "hooks.json")),
        state: state.unwrap_or_else(|| harness.file(&state_dir, "state.json")),
        log_dir: log_dir.unwrap_or_else(|| state_dir.join("log")),
    };
    let cmd = match positional.as_slice() {
        [s] if s == "settings" && settings.is_none() => Cmd::Settings {
            bin: bin.map_or_else(own_path, Ok)?,
        },
        [s] if s == "install" => Cmd::Install {
            bin: bin.map_or_else(|| own_path().and_then(outlasting), Ok)?,
            settings: settings.unwrap_or_else(|| harness.settings_file(&home())),
        },
        [e] if looks_like_event(e) && bin.is_none() && settings.is_none() => Cmd::Hook(e.clone()),
        _ => return Err("expected one event name, `settings` or `install`".into()),
    };
    Ok((paths, harness, cmd))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Know the event before anything can fail, so a broken invocation still
    // fails closed on PreToolUse.
    if let Some(last) = args.last().filter(|a| looks_like_event(a)) {
        let _ = EVENT.set(last.clone());
    }
    match parse_args(&args) {
        Ok((paths, harness, Cmd::Hook(event))) => hook(&paths, harness, &event),
        Ok((paths, harness, Cmd::Settings { bin })) => settings(&paths, harness, &bin),
        Ok((paths, harness, Cmd::Install { bin, settings })) => {
            install(&paths, harness, &bin, &settings)
        }
        Err(msg) if msg.is_empty() => {
            println!("{USAGE}");
            exit(0)
        }
        Err(msg) if EVENT.get().is_some() => fail(&msg),
        Err(msg) => {
            eprintln!("route: {msg}\n{USAGE}");
            exit(1)
        }
    }
}

fn install(paths: &Paths, harness: Harness, bin: &str, target: &std::path::Path) -> ! {
    let result = config::load(&paths.config)
        .and_then(|cfg| config::settings_block(&cfg, bin, harness))
        .and_then(|(block, warnings)| {
            for w in warnings {
                eprintln!("route: warning: {w}");
            }
            install::install(target, &block["hooks"])
        });
    match result {
        Ok(install::Done::Unchanged) => {
            println!(
                "route: {} already hands each event to route; nothing to write",
                target.display()
            );
            exit(0)
        }
        Ok(install::Done::Wrote(changes)) => {
            println!("route: wrote {}", target.display());
            for c in changes {
                println!("  {c}");
            }
            println!("{}", harness.reload_hint());
            exit(0)
        }
        Err(e) => {
            eprintln!("route: {e}");
            exit(1)
        }
    }
}

fn settings(paths: &Paths, harness: Harness, bin: &str) -> ! {
    let result =
        config::load(&paths.config).and_then(|cfg| config::settings_block(&cfg, bin, harness));
    match result {
        Ok((block, warnings)) => {
            for w in warnings {
                eprintln!("route: warning: {w}");
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&block).expect("a Value serializes")
            );
            exit(0)
        }
        Err(e) => {
            eprintln!("route: {e}");
            exit(1)
        }
    }
}

fn hook(paths: &Paths, harness: Harness, event: &str) -> ! {
    std::panic::set_hook(Box::new(|info| {
        // A guard's panic unwinds to guards::run, which reports that guard as
        // a failed handler.
        if guards::in_guard() {
            return;
        }
        fail(&format!("internal error: {info}"))
    }));
    forward_signals();
    let started = Instant::now();
    let now = Local::now();

    let mut input = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut input) {
        fail(&format!("reading stdin: {e}"));
    }
    let payload: Value =
        serde_json::from_slice(&input).unwrap_or_else(|e| fail(&format!("stdin is not JSON: {e}")));
    let mut notes = Vec::new();
    if let Some(name) = payload.get("hook_event_name").and_then(Value::as_str)
        && name != event
    {
        notes.push(format!("stdin names {name}, the argument names {event}"));
    }

    let cfg = config::load(&paths.config).unwrap_or_else(|e| fail(&format!("hooks file {e}")));
    notes.extend(cfg.notes.iter().cloned());
    let (disabled, note) = config::load_state(&paths.state);
    notes.extend(note);
    let (selected, skipped) =
        config::select(&cfg, event, &payload, &disabled).unwrap_or_else(|e| fail(&e));
    let (asyncs, syncs): (Vec<Selected>, Vec<Selected>) =
        selected.into_iter().partition(|s| s.handler.is_async);

    // Every handler is killed at its own timeout, so overrunning the largest
    // one by a second means route itself is stuck.
    let budget = syncs.iter().map(Selected::timeout).fold(0.0, f64::max) + 1.0;
    thread::spawn(move || {
        thread::sleep(Duration::from_secs_f64(budget));
        fail(&format!("no answer within {budget}s"));
    });

    let mut feeds = Vec::new();
    let mut async_log = Vec::new();
    for s in &asyncs {
        let mut rec = handler_json(s);
        rec["async"] = true.into();
        match run::spawn_async(&s.handler.command, &input) {
            Ok(fed) => feeds.push(fed),
            Err(e) => rec["spawn_error"] = e.into(),
        }
        async_log.push(rec);
    }

    // Processes start first; the in-process guards answer while they run, on
    // one shared parse of the command.
    let jobs: Vec<(String, f64)> = syncs
        .iter()
        .filter(|s| s.builtin.is_none())
        .map(|s| (s.handler.command.clone(), s.timeout()))
        .collect();
    let ctx = guards::Ctx::new(&payload);
    let (external, builtin) = run::run_all_with(&jobs, &input, || {
        syncs
            .iter()
            .filter_map(|s| s.builtin)
            .map(|g| guards::run(g, &ctx))
            .collect::<Vec<_>>()
    });
    let (mut external, mut builtin) = (external.into_iter(), builtin.into_iter());
    let outcomes: Vec<run::Outcome> = syncs
        .iter()
        .map(|s| match s.builtin {
            Some(_) => builtin.next(),
            None => external.next(),
        })
        .map(|o| o.expect("one outcome per handler"))
        .collect();
    let answers: Vec<Answer> = syncs
        .iter()
        .zip(&outcomes)
        .map(|(s, o)| Answer {
            label: &s.handler.command,
            timeout: s.timeout(),
            outcome: o,
        })
        .collect();
    let resp = merge::respond(event, &answers);
    notes.extend(resp.notes.iter().cloned());

    let limits = &cfg.log;
    let mut handlers: Vec<Value> = syncs
        .iter()
        .zip(&answers)
        .map(|(s, a)| {
            let o = a.outcome;
            let effect = merge::normalize(event, a);
            let mut rec = handler_json(s);
            rec["exit"] = json!(o.exit);
            rec["ms"] = o.ms.into();
            if let Some(g) = s.builtin {
                rec["builtin"] = g.name.into();
            }
            if let Some(us) = o.us {
                rec["us"] = us.into();
            }
            rec["outcome"] = effect.summary().into();
            if let Some(sig) = o.signal {
                rec["signal"] = sig.into();
            }
            if o.timed_out {
                rec["timed_out"] = true.into();
            }
            if let Some(e) = &o.spawn_error {
                rec["spawn_error"] = e.as_str().into();
            }
            if effect.context_chars() > 0 {
                rec["context_chars"] = effect.context_chars().into();
            }
            for (key, text) in [("stdout", o.stdout_text()), ("stderr", o.stderr_text())] {
                if !text.is_empty() {
                    rec[key] = log::truncate(&text, limits.max_output_chars).into();
                }
            }
            rec
        })
        .collect();
    handlers.extend(async_log);

    let mut record = json!({
        "v": 1,
        "ts": now.to_rfc3339_opts(SecondsFormat::Millis, false),
        "harness": harness.name(),
        "event": event,
        "session_id": payload.get("session_id"),
        "cwd": payload.get("cwd"),
        "mode": resp.mode,
        "decision": resp.decision,
        "exit": resp.exit,
        "ms": started.elapsed().as_millis() as u64,
        "handlers": handlers,
    });
    if let Some(tool) = payload.get("tool_name") {
        record["tool"] = tool.clone();
    }
    if let Some(text) = log::input_summary(&payload) {
        record["input"] = log::truncate(&text, limits.max_input_chars).into();
    }
    if !resp.reasons.is_empty() {
        let reasons: Vec<String> = resp
            .reasons
            .iter()
            .map(|r| log::truncate(r, limits.max_output_chars))
            .collect();
        record["reasons"] = reasons.into();
    }
    if resp.context_chars > 0 {
        record["context_chars"] = resp.context_chars.into();
    }
    if !skipped.is_empty() {
        record["skipped"] = skipped.iter().map(config::HandlerId::to_json).collect();
    }
    if !notes.is_empty() {
        record["notes"] = notes.into();
    }

    emit(&resp.stdout, &resp.stderr, resp.exit);

    let mut line = record.to_string();
    line.push('\n');
    if let Err(e) = log::append(&paths.log_dir, line.as_bytes(), limits.retention_days, now) {
        // Claude Code never shows stderr from a hook that exits 0, so the note
        // reaches only its debug log; on any other exit, stderr is the reason
        // or notice and stays untouched.
        if resp.exit == 0 {
            eprintln!("route: log: {e}");
        }
    }

    let until = Instant::now() + ASYNC_FEED_WAIT;
    for fed in feeds {
        let _ = fed.recv_timeout(until.saturating_duration_since(Instant::now()));
    }
    exit(resp.exit)
}

fn handler_json(s: &Selected) -> Value {
    json!({"matcher": s.id.matcher, "command": s.id.command})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_takes_no_path_from_the_nix_store() {
        let err = outlasting("/nix/store/abc-route-0.1.0/bin/route".into()).unwrap_err();
        assert!(err.contains("--bin"), "{err}");
        assert_eq!(
            outlasting("~/.local/libexec/route".into()).as_deref(),
            Ok("~/.local/libexec/route")
        );
    }
}
