//! Address resolution: map a structural address (`"0"`/`text`, a dotted-numeric
//! path, or a heading slug) onto a node in the document tree.

use anyhow::Result;

use crate::model::{Document, Node, flatten, is_numeric_address};

/// Why an address failed to resolve. Carries the data each variant needs to
/// reproduce the exact message the `resolve_address` wrapper prints.
#[derive(Debug)]
pub(crate) enum ResolveError {
    /// `[0]`/`text` requested but the file has no text region.
    NoTextRegion(String),
    /// Numeric address whose segment overflows `usize` or indexes past the tree.
    OutOfRange(String),
    /// Slug matched no heading.
    NoSlugMatch(String),
    /// Slug matched more than one heading; holds the candidate `(address, heading)` pairs.
    Ambiguous(String, Vec<(String, String)>),
}

/// Pure address resolution: all the descent/match logic, no IO.
/// `resolve_address` wraps this to format the error; tests call it directly so
/// there is no parallel test mirror to drift.
pub(crate) fn resolve<'a>(doc: &'a Document, address: &str) -> Result<&'a Node, ResolveError> {
    // `[0]` / `text` → the synthetic text node. Reserved, like `fm` and `links`:
    // matched before the heading tree, so a heading slugging to `text` is
    // reachable only by its number. `resolve_address` says so on the miss. The
    // predicate is `shadow`'s, so the interception and the announcement cannot
    // drift over which addresses the text reading owns.
    if crate::shadow::reserved_reading(address) == Some(crate::shadow::Reading::Text) {
        return doc
            .text
            .as_ref()
            .ok_or_else(|| ResolveError::NoTextRegion(address.to_string()));
    }

    // Numeric dotted address: descend by 1-based index.
    if is_numeric_address(address) {
        let mut parts: Vec<usize> = Vec::new();
        for seg in address.split('.') {
            // An all-digit segment can still overflow `usize`; treat overflow as
            // out-of-range rather than panicking.
            match seg.parse::<usize>() {
                Ok(n) => parts.push(n),
                Err(_) => return Err(ResolveError::OutOfRange(address.to_string())),
            }
        }
        let mut level: &[Node] = &doc.tree;
        let mut current: Option<&Node> = None;
        for (depth, &idx) in parts.iter().enumerate() {
            if idx == 0 || idx > level.len() {
                return Err(ResolveError::OutOfRange(address.to_string()));
            }
            let node = &level[idx - 1];
            current = Some(node);
            if depth + 1 < parts.len() {
                level = &node.children;
            }
        }
        return Ok(current.expect("numeric address yields a node"));
    }

    // Slug: collect nodes whose `slug == needle`.
    let needle = crate::slug::segment(address);
    let mut all: Vec<&Node> = Vec::new();
    flatten(&doc.tree, &mut all);
    let matches: Vec<&Node> = all.into_iter().filter(|n| n.slug == needle).collect();
    match matches.len() {
        0 => Err(ResolveError::NoSlugMatch(needle)),
        1 => Ok(matches[0]),
        _ => Err(ResolveError::Ambiguous(
            needle,
            matches
                .iter()
                .map(|n| (n.address.clone(), n.heading.clone()))
                .collect(),
        )),
    }
}

/// Resolve an address against a document, returning an error that names the
/// failure rather than exiting. `main` owns the exit code, so a miss propagates
/// with `?`. Thin wrapper over the pure `resolve`.
pub(crate) fn resolve_address<'a>(doc: &'a Document, address: &str) -> Result<&'a Node> {
    match resolve(doc, address) {
        Ok(n) => Ok(n),
        Err(ResolveError::NoTextRegion(addr)) => {
            // As with `fm`: a reserved address that resolved to nothing names the
            // heading that answers to the same word, and how to reach it.
            let mut msg = format!("No text region in this file (address '{}')", addr);
            if let Some(p) = crate::shadow::phrase(doc, &addr) {
                msg.push_str(&format!("; {}", p));
            }
            Err(anyhow::anyhow!(msg))
        }
        Err(ResolveError::OutOfRange(addr)) => {
            Err(anyhow::anyhow!("Address '{}' out of range", addr))
        }
        Err(ResolveError::NoSlugMatch(needle)) => {
            Err(anyhow::anyhow!("No heading matches slug '{}'", needle))
        }
        Err(ResolveError::Ambiguous(needle, candidates)) => {
            let mut msg = format!("Ambiguous slug '{}'; candidates:", needle);
            for (addr, heading) in &candidates {
                msg.push_str(&format!("\n  {}  {}", addr, heading));
            }
            Err(anyhow::anyhow!(msg))
        }
    }
}
