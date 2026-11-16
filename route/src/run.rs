//! Running handlers: each one under `bash -c`, as Claude Code runs a shell-form
//! command hook, with the event JSON on stdin and Claude Code's environment and
//! working directory inherited through route.

use std::io::{Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering::SeqCst};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long route keeps reading a handler's stdout and stderr after the
/// handler exits. A background process the handler started can hold the pipes
/// open, so route reads what arrived and moves on instead of waiting for EOF.
const DRAIN_GRACE: Duration = Duration::from_millis(200);

/// Process groups of the sync handlers not yet reaped, so route can take them
/// down when it dies first: on a signal, a panic, or its own deadline. Atomics
/// only, because a signal handler reads them. A handler past the last slot
/// goes untracked.
static RUNNING: [AtomicI32; 64] = [const { AtomicI32::new(0) }; 64];

fn track(pid: i32) {
    let _ = RUNNING
        .iter()
        .find(|slot| slot.compare_exchange(0, pid, SeqCst, SeqCst).is_ok());
}

fn untrack(pid: i32) {
    let _ = RUNNING
        .iter()
        .find(|slot| slot.compare_exchange(pid, 0, SeqCst, SeqCst).is_ok());
}

/// Kills every tracked handler's process group. Async-signal-safe: it touches
/// only atomics and kill(2).
pub fn kill_running() {
    for slot in &RUNNING {
        let pid = slot.load(SeqCst);
        if pid > 0 {
            // SAFETY: kill(2) on a handler's own process group; the slot is
            // cleared as soon as that handler is reaped.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Outcome {
    /// `None` when the handler never started, timed out, or died on a signal.
    pub exit: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub spawn_error: Option<String>,
    pub ms: u64,
}

impl Outcome {
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

fn command(cmd: &str) -> Command {
    let mut c = Command::new("bash");
    // Each handler leads its own process group, so a timeout kills whatever it
    // started along with it.
    c.arg("-c").arg(cmd).process_group(0);
    c
}

/// Writes the payload on its own thread. A handler that never reads stdin
/// (`mkdir -p`, `sound.sh`) closes the pipe early, and the write error that
/// follows is expected, so it is dropped. Returns a receiver that fires when
/// the write ends either way.
fn feed(child: &mut Child, input: &Arc<[u8]>) -> Receiver<()> {
    let (tx, rx) = mpsc::channel();
    if let Some(mut stdin) = child.stdin.take() {
        let input = Arc::clone(input);
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
            drop(stdin);
            let _ = tx.send(());
        });
    }
    rx
}

/// Collects a pipe into a shared buffer as bytes arrive, so a reader still
/// blocked when the grace period ends leaves behind what it read.
fn collect(mut pipe: impl Read + Send + 'static) -> (Arc<Mutex<Vec<u8>>>, Receiver<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel();
    let sink = Arc::clone(&buf);
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => sink.lock().unwrap().extend_from_slice(&chunk[..n]),
            }
        }
        let _ = tx.send(());
    });
    (buf, rx)
}

struct Running {
    pid: i32,
    started: Instant,
    deadline: Instant,
    exited: Receiver<std::io::Result<std::process::ExitStatus>>,
    stdout: (Arc<Mutex<Vec<u8>>>, Receiver<()>),
    stderr: (Arc<Mutex<Vec<u8>>>, Receiver<()>),
}

/// Runs every handler at once and waits for each until its own timeout, in
/// seconds. Results come back in the order given.
pub fn run_all(handlers: &[(String, f64)], input: &[u8]) -> Vec<Outcome> {
    let input: Arc<[u8]> = Arc::from(input);
    let started: Vec<Result<Running, Outcome>> = handlers
        .iter()
        .map(|(cmd, timeout)| start(cmd, *timeout, &input))
        .collect();
    started
        .into_iter()
        .map(|r| match r {
            Ok(running) => finish(running),
            Err(failed) => failed,
        })
        .collect()
}

fn start(cmd: &str, timeout: f64, input: &Arc<[u8]>) -> Result<Running, Outcome> {
    let started = Instant::now();
    let mut child = command(cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Outcome {
            spawn_error: Some(e.to_string()),
            ..Outcome::default()
        })?;
    let pid = child.id() as i32;
    track(pid);
    feed(&mut child, input);
    let stdout = collect(child.stdout.take().expect("stdout is piped"));
    let stderr = collect(child.stderr.take().expect("stderr is piped"));
    let (tx, exited) = mpsc::channel();
    thread::spawn(move || {
        let status = child.wait();
        untrack(pid);
        let _ = tx.send(status);
    });
    Ok(Running {
        pid,
        started,
        deadline: started + Duration::from_secs_f64(timeout),
        exited,
        stdout,
        stderr,
    })
}

fn finish(r: Running) -> Outcome {
    let wait = r.deadline.saturating_duration_since(Instant::now());
    let (status, timed_out) = match r.exited.recv_timeout(wait) {
        Ok(status) => (status.ok(), false),
        Err(_) => {
            // SAFETY: kill(2) on the handler's own process group; the pid came
            // from a child this process spawned and has not yet reaped.
            unsafe {
                libc::kill(-r.pid, libc::SIGKILL);
            }
            (r.exited.recv().ok().and_then(Result::ok), true)
        }
    };
    let ms = r.started.elapsed().as_millis() as u64;
    let grace = Instant::now() + DRAIN_GRACE;
    let drained = |(buf, done): (Arc<Mutex<Vec<u8>>>, Receiver<()>)| {
        let _ = done.recv_timeout(grace.saturating_duration_since(Instant::now()));

        buf.lock().unwrap().clone()
    };
    let stdout = drained(r.stdout);
    let stderr = drained(r.stderr);
    let (exit, signal) = match (timed_out, status) {
        (true, _) | (_, None) => (None, status.and_then(|s| s.signal())),
        (false, Some(s)) => (s.code(), s.signal()),
    };
    Outcome {
        exit,
        signal,
        stdout,
        stderr,
        timed_out,
        spawn_error: None,
        ms,
    }
}

/// Starts an async handler and leaves it running. Its stdout and stderr go to
/// /dev/null: a pipe back to route would keep Claude Code's read of route's
/// own output open until the handler, and anything it started, exits. Returns
/// a receiver that fires once the payload is written, or `Err` if it never
/// started.
pub fn spawn_async(cmd: &str, input: &[u8]) -> Result<Receiver<()>, String> {
    let mut child = command(cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let input: Arc<[u8]> = Arc::from(input);
    Ok(feed(&mut child, &input))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(cmd: &str, timeout: f64, input: &[u8]) -> Outcome {
        run_all(&[(cmd.to_string(), timeout)], input).remove(0)
    }

    #[test]
    fn captures_exit_code_stdout_and_stderr() {
        let o = one("cat; echo oops >&2; exit 3", 5.0, b"payload");
        assert_eq!(o.exit, Some(3));
        assert_eq!(o.stdout, b"payload");
        assert_eq!(o.stderr, b"oops\n");
        assert!(!o.timed_out);
    }

    #[test]
    fn handlers_run_in_parallel() {
        let started = Instant::now();
        let outs = run_all(
            &[
                ("sleep 0.4".into(), 5.0),
                ("sleep 0.4".into(), 5.0),
                ("sleep 0.4".into(), 5.0),
            ],
            b"",
        );
        assert!(outs.iter().all(|o| o.exit == Some(0)));
        assert!(
            started.elapsed() < Duration::from_millis(1000),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_timeout_kills_the_handler_and_its_children() {
        let started = Instant::now();
        let o = one("sleep 30 & sleep 30", 0.3, b"");
        assert!(o.timed_out);
        assert_eq!(o.exit, None);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_handler_that_ignores_a_large_stdin_still_finishes() {
        let big = vec![b'x'; 1 << 20];
        let o = one("echo done", 5.0, &big);
        assert_eq!(o.exit, Some(0));
        assert_eq!(o.stdout, b"done\n");
    }

    #[test]
    fn a_background_child_holding_stdout_does_not_hold_route() {
        let started = Instant::now();
        let o = one("echo first; sleep 5 &", 10.0, b"");
        assert_eq!(o.exit, Some(0));
        assert_eq!(o.stdout, b"first\n");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }
}
