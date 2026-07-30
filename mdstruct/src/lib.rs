//! `mdstruct` — a shared comrak-backed markdown structural-parsing core.
//!
//! Locates structure and emits half-open byte spans; consumers slice their own
//! original bytes and never restringify (byte-exact write-back preserved). The
//! `#[derive(Serialize)]` shape of [`Document`] IS the JSON contract ([[mdstruct-plan]] §2).

mod core;

// Re-exported so a sibling crate (e.g. a formatter) that calls
// `comrak_options` below gets the SAME `comrak::Options` type our own parse
// uses, guaranteed by construction rather than by both crates happening to
// pin the same comrak version.
pub use comrak;
pub use core::build::{Options, build_document};
pub use core::model::{
    Document, FrontMatter, Heading, Inline, Node, Region, SCHEMA_VERSION, Source, Span,
};
pub use core::verify::{SpanMismatch, verify_spans};

use std::str::Utf8Error;

/// The comrak parse configuration mdstruct's core builds against, exposed so
/// a sibling crate (e.g. a formatter) parses under the IDENTICAL settings —
/// the two can never disagree about the parse. `mod core` stays private;
/// this wrapper is the only door into its comrak configuration, so the
/// module tree itself never becomes public API.
pub fn comrak_options(opts: &Options) -> comrak::Options<'static> {
    core::build::comrak_options(opts)
}

/// Parse in-memory UTF-8 source. Never fails for valid UTF-8.
pub fn parse(source: &str, opts: &Options) -> Document {
    build_document("-", source, opts)
}

/// Parse with an explicit source path (recorded in `source.path`).
pub fn parse_path(path: &str, source: &str, opts: &Options) -> Document {
    build_document(path, source, opts)
}

/// Bin entry: parse raw bytes, erroring if not valid UTF-8 (comrak needs `&str`).
pub fn parse_bytes(path: &str, source: &[u8], opts: &Options) -> Result<Document, Utf8Error> {
    let s = std::str::from_utf8(source)?;
    Ok(build_document(path, s, opts))
}
