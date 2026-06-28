//! OS dark-mode detection, isolated from the renderer so the latter stays pure.

/// Returns `true` when macOS reports the global appearance as Dark. Any failure
/// (non-macOS, command missing, light mode) yields `false`.
pub(super) fn detect_dark_mode() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "Dark")
        .unwrap_or(false)
}
