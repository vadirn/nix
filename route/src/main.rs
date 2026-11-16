//! route: the one Claude Code hook entry per event.
//!
//! `settings.json` calls `route <Event>` with the event JSON on stdin. route
//! picks the handlers its hooks file lists for that event, runs them in
//! parallel, answers Claude Code once, and appends one JSONL line to the log.
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
use merge::Answer;

const USAGE: &str = "\
usage: route [--config PATH] [--state PATH] [--log-dir PATH] <Event>
       route [--config PATH] settings [--bin PATH]

  <Event>    run the handlers for one Claude Code hook event; the event JSON
             arrives on stdin
  settings   print the settings.json `hooks` block that hands every event in
             the hooks file to route, calling the binary at --bin

  --config   hooks file, Claude Code's {\"hooks\": ...} shape
             (default ~/.config/route/hooks.json)
  --state    handlers switched off (default ~/.local/state/route/state.json)
  --log-dir  per-day JSONL logs (default ~/.local/state/route/log)";

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
}

fn xdg(var: &str, fallback: &str) -> PathBuf {
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| "/".into());
            home.join(fallback)
        }
    }
}

fn looks_like_event(s: &str) -> bool {
    s != "settings"
        && s.starts_with(|c: char| c.is_ascii_uppercase())
        && s.chars().all(|c| c.is_ascii_alphabetic())
}

fn parse_args(args: &[String]) -> Result<(Paths, Cmd), String> {
    let mut paths = Paths {
        config: xdg("XDG_CONFIG_HOME", ".config").join("route/hooks.json"),
        state: xdg("XDG_STATE_HOME", ".local/state").join("route/state.json"),
        log_dir: xdg("XDG_STATE_HOME", ".local/state").join("route/log"),
    };
    let mut bin = None;
    let mut positional = Vec::new();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--config" => paths.config = value("--config")?.into(),
            "--state" => paths.state = value("--state")?.into(),
            "--log-dir" => paths.log_dir = value("--log-dir")?.into(),
            "--bin" => bin = Some(value("--bin")?),
            "-h" | "--help" => return Err(String::new()),
            flag if flag.starts_with('-') => return Err(format!("unknown flag {flag}")),
            word => positional.push(word.to_string()),
        }
    }
    let cmd = match positional.as_slice() {
        [s] if s == "settings" => Cmd::Settings {
            bin: match bin {
                Some(b) => b,
                None => std::env::current_exe()
                    .map_err(|e| format!("cannot find route's own path: {e}"))?
                    .display()
                    .to_string(),
            },
        },
        [e] if looks_like_event(e) && bin.is_none() => Cmd::Hook(e.clone()),
        _ => return Err("expected one event name or `settings`".into()),
    };
    Ok((paths, cmd))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Know the event before anything can fail, so a broken invocation still
    // fails closed on PreToolUse.
    if let Some(last) = args.last().filter(|a| looks_like_event(a)) {
        let _ = EVENT.set(last.clone());
    }
    match parse_args(&args) {
        Ok((paths, Cmd::Hook(event))) => hook(&paths, &event),
        Ok((paths, Cmd::Settings { bin })) => settings(&paths, &bin),
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

fn settings(paths: &Paths, bin: &str) -> ! {
    let result = config::load(&paths.config).and_then(|cfg| config::settings_block(&cfg, bin));
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

fn hook(paths: &Paths, event: &str) -> ! {
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
