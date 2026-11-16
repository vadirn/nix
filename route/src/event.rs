//! What Claude Code does with each hook event, as far as route needs to know.
//!
//! Source: the hooks reference, https://code.claude.com/docs/en/hooks, read on
//! 2026-11-16 against Claude Code 2.1.325. An event missing from these tables
//! gets the most conservative treatment: its matchers are refused and a merged
//! block keeps exit code 2.

/// How an event expresses a block, which decides how route writes a merged one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    /// `hookSpecificOutput.permissionDecision`. Exit 2 routes as `deny`.
    Permission,
    /// Top-level `decision: "block"` with `reason`. Exit 2 routes as the reason.
    Decision,
    /// Only exit 2 blocks, so a merged block keeps exit 2 and joins the stderr.
    ExitCode,
    /// Exit 2 only shows stderr to the user, as a hook error notice.
    Notice,
    /// Exit code 2 and stderr are ignored.
    Ignored,
}

pub fn block(event: &str) -> Block {
    match event {
        "PreToolUse" => Block::Permission,
        "UserPromptSubmit"
        | "UserPromptExpansion"
        | "PostToolUse"
        | "PostToolUseFailure"
        | "PostToolBatch"
        | "Stop"
        | "SubagentStop"
        | "ConfigChange"
        | "PreCompact"
        | "TaskCreated"
        | "Elicitation"
        | "ElicitationResult" => Block::Decision,
        "SessionStart" | "SessionEnd" | "CwdChanged" | "FileChanged" | "SubagentStart"
        | "PostCompact" | "PostModelSwitch" => Block::Notice,
        "Notification" | "Setup" | "PermissionDenied" | "StopFailure" | "InstructionsLoaded"
        | "MessageDisplay" | "PermissionRequest" | "DirectoryAdded" => Block::Ignored,
        // TeammateIdle, TaskCompleted, PreModelSwitch, WorktreeCreate and
        // WorktreeRemove block by exit code alone, and an unknown event keeps
        // whatever exit 2 means there.
        _ => Block::ExitCode,
    }
}

/// Events whose plain-text stdout on exit 0 reaches Claude as context.
pub fn stdout_is_context(event: &str) -> bool {
    matches!(
        event,
        "UserPromptSubmit" | "UserPromptExpansion" | "SessionStart" | "PostModelSwitch"
    )
}

/// What an event's matcher is tested against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchOn {
    /// A string field of the stdin JSON.
    Field(&'static str),
    /// The event has no matcher support, and Claude Code ignores any matcher.
    Ignored,
    /// The event takes a matcher, but route does not know its field.
    Unknown,
}

pub fn match_on(event: &str) -> MatchOn {
    match event {
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest"
        | "PermissionDenied" => MatchOn::Field("tool_name"),
        "SessionStart" | "ConfigChange" => MatchOn::Field("source"),
        "SessionEnd" => MatchOn::Field("reason"),
        "Notification" => MatchOn::Field("notification_type"),
        "SubagentStart" | "SubagentStop" => MatchOn::Field("agent_type"),
        "PreCompact" | "PostCompact" => MatchOn::Field("trigger"),
        "UserPromptSubmit" | "PostToolBatch" | "Stop" | "TeammateIdle" | "TaskCreated"
        | "TaskCompleted" | "WorktreeCreate" | "WorktreeRemove" | "MessageDisplay"
        | "CwdChanged" => MatchOn::Ignored,
        _ => MatchOn::Unknown,
    }
}

/// Events whose matcher's exact-string form allows only letters, digits, `_`
/// and `|`. A hyphen, space or comma there sends the matcher down the regex path.
pub fn narrow_exact(event: &str) -> bool {
    matches!(event, "FileChanged" | "StopFailure")
}

/// Claude Code's timeout, in seconds, for a command hook that sets none.
/// SessionEnd hooks share a 1.5-second budget instead.
pub fn default_timeout(event: &str) -> f64 {
    match event {
        "UserPromptSubmit" | "PreModelSwitch" | "PostModelSwitch" => 30.0,
        "MessageDisplay" => 10.0,
        "SessionEnd" => 1.5,
        _ => 600.0,
    }
}

/// The event on which a route failure blocks instead of letting the action
/// through. Decided 2026-11-16: a broken guard path must not silently allow
/// tool calls, and failing closed anywhere else could block Stop in a loop.
pub fn fails_closed(event: &str) -> bool {
    event == "PreToolUse"
}
