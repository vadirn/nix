//! Vault-body section addressing.
//!
//! A single primitive — [`section_ranges`] — that maps a Markdown body onto the
//! structural addresses `read` resolves (`"0"`/`text` for the pre-heading lede,
//! then dotted-numeric heading addresses like `1.2`) together with the inclusive
//! 1-based line range each section owns. Callers (e.g. `consult`'s pointer
//! assembly) use it to attribute body positions to sections without rendering
//! the full heading tree.
//!
//! The heading/fence detection is shared with `read` through [`crate::markdown`]
//! rather than re-implemented here; only the address/range arithmetic lives in
//! this module. Addresses are kept identical to `read`'s overview tree so an
//! address produced here resolves against the on-disk file via
//! `read <path> <address>`.

/// A section's structural address and the inclusive 1-based line range it owns,
/// for callers that map positions onto sections without rendering the tree.
#[derive(Debug, Clone)]
pub struct SectionRange {
    pub address: String,
    pub level: usize,
    pub start: usize,
    pub end: usize,
}

/// Concatenate the inclusive 1-based line range back into a string slice so a
/// region can be tested for non-whitespace. Lines were split on `'\n'`, so
/// rejoin with `'\n'`.
fn range_slice(lines: &[&str], start: usize, end: usize) -> String {
    if start == 0 || start > lines.len() {
        return String::new();
    }
    let s = start - 1;
    let e = end.min(lines.len());
    lines[s..e].join("\n")
}

/// Parse `body` and return its section ranges depth-first: the synthetic
/// `(text)` region (address `"0"`) leads when present, then the heading tree in
/// document order (which is pre-order for a heading tree). Empty when the body
/// has no headings and no pre-heading prose.
///
/// Line numbers are relative to `body`. Addresses are structural (numeric), so
/// an address computed from a frontmatter-stripped body still resolves against
/// the on-disk file via `read <path> <address>`.
pub fn section_ranges(body: &str) -> Vec<SectionRange> {
    let lines: Vec<&str> = body.lines().collect();
    let total = lines.len();

    // The 1-based line at which the body begins, i.e. the line after the closing
    // frontmatter `---`. Without frontmatter the body begins at line 1.
    let body_start = crate::frontmatter::body_start_line(body);

    // First pass: collect heading (level, line), skipping fenced code so a `#`
    // inside a code block is not a heading. Fence and heading detection are the
    // canonical primitives from `crate::markdown`.
    struct RawHeading {
        level: usize,
        line: usize,
    }
    let mut raw: Vec<RawHeading> = Vec::new();
    let mut fence: Option<char> = None; // Some('`')/Some('~') while inside a fence.

    for (idx, raw_line) in lines.iter().enumerate() {
        let lineno = idx + 1;
        if lineno < body_start {
            continue;
        }
        let trimmed = raw_line.trim_start();
        if let Some(marker) = crate::markdown::fence_marker(trimmed) {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                Some(_) => {} // a different marker inside a fence is literal content
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((level, _text)) = crate::markdown::atx_heading(raw_line) {
            raw.push(RawHeading { level, line: lineno });
        }
    }

    let mut ranges: Vec<SectionRange> = Vec::new();

    // Text region: body content before the first heading (or the whole body when
    // heading-less). Emit only when it holds non-whitespace, with leading blank
    // lines trimmed so `start` points at the first non-blank line.
    let region_start = body_start.max(1);
    let region_end = if let Some(first) = raw.first() {
        first.line.saturating_sub(1)
    } else {
        total
    };
    if region_end >= region_start
        && !range_slice(&lines, region_start, region_end).trim().is_empty()
    {
        let mut first_line = region_start;
        while first_line <= region_end
            && lines.get(first_line - 1).is_none_or(|l| l.trim().is_empty())
        {
            first_line += 1;
        }
        ranges.push(SectionRange {
            address: "0".to_string(),
            level: 0,
            start: first_line,
            end: region_end,
        });
    }

    // Heading ranges. Content end for heading `i` is the line before the next
    // heading with `level <= raw[i].level`, else `total`.
    let ends: Vec<usize> = (0..raw.len())
        .map(|i| {
            let mut end = total;
            for j in (i + 1)..raw.len() {
                if raw[j].level <= raw[i].level {
                    end = raw[j].line - 1;
                    break;
                }
            }
            end
        })
        .collect();

    // Assign dotted-numeric addresses with a level-stack, matching `read`'s tree
    // builder: top-level headings are `1..N`; a child is `parent + "." + idx`.
    // Document order is pre-order, so emitting here mirrors a depth-first flatten.
    let mut stack: Vec<(usize, String, usize)> = Vec::new(); // (level, address, child_count)
    let mut root_count = 0usize;
    for (i, h) in raw.iter().enumerate() {
        while let Some(&(top_level, _, _)) = stack.last() {
            if top_level >= h.level {
                stack.pop();
            } else {
                break;
            }
        }
        let address = match stack.last_mut() {
            None => {
                root_count += 1;
                root_count.to_string()
            }
            Some((_, parent_addr, child_count)) => {
                *child_count += 1;
                format!("{}.{}", parent_addr, child_count)
            }
        };
        ranges.push(SectionRange {
            address: address.clone(),
            level: h.level,
            start: h.line,
            end: ends[i],
        });
        stack.push((h.level, address, 0));
    }

    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "lede line\n\n# One\nbody\n## One A\nmore\n# Two\ntail\n";

    #[test]
    fn text_region_leads_then_headings_in_order() {
        let r = section_ranges(SAMPLE);
        let addrs: Vec<&str> = r.iter().map(|s| s.address.as_str()).collect();
        assert_eq!(addrs, ["0", "1", "1.1", "2"]);
    }

    #[test]
    fn ranges_carry_level_and_inclusive_bounds() {
        let r = section_ranges(SAMPLE);
        // text region: first non-blank line through line before first heading.
        assert_eq!((r[0].level, r[0].start, r[0].end), (0, 1, 2));
        // "# One" at line 3 owns through line before "# Two" (line 6).
        assert_eq!((r[1].level, r[1].start, r[1].end), (1, 3, 6));
        // "## One A" at line 5 owns through line 6.
        assert_eq!((r[2].level, r[2].start, r[2].end), (2, 5, 6));
        // "# Two" at line 7 owns to EOF (line 8).
        assert_eq!((r[3].level, r[3].start, r[3].end), (1, 7, 8));
    }

    #[test]
    fn empty_for_blank_and_heading_less_no_prose() {
        assert!(section_ranges("").is_empty());
        assert!(section_ranges("   \n\n").is_empty());
    }

    #[test]
    fn heading_less_body_is_one_text_region() {
        let r = section_ranges("just prose\nmore prose\n");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].address, "0");
        assert_eq!((r[0].start, r[0].end), (1, 2));
    }

    #[test]
    fn hash_inside_fence_is_not_a_heading() {
        let body = "# Real\n```\n# fake\n```\ntail\n";
        let r = section_ranges(body);
        let addrs: Vec<&str> = r.iter().map(|s| s.address.as_str()).collect();
        assert_eq!(addrs, ["1"]);
        assert_eq!(r[0].end, 5);
    }

    #[test]
    fn frontmatter_is_skipped_before_body() {
        let body = "---\ntitle: x\n---\n# Heading\nbody\n";
        let r = section_ranges(body);
        // No text region (frontmatter is not prose); one heading at line 4.
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].address, "1");
        assert_eq!((r[0].start, r[0].end), (4, 5));
    }
}
