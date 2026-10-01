//! Vault-body section ranges.
//!
//! [`section_ranges`] maps a Markdown body onto its sections, each with the
//! inclusive 1-based line range it owns. A caller turns a range into lines a
//! reader opens directly.

/// A section's heading level and the inclusive 1-based line range it owns. The
/// `(text)` region before the first heading has level 0.
#[derive(Debug, Clone)]
pub struct SectionRange {
    pub level: usize,
    pub start: usize,
    pub end: usize,
}

/// Concatenate the inclusive 1-based line range back into a string slice so a
/// region can be tested for non-whitespace. Lines were split by
/// [`crate::mdfacet::lines`] (line endings dropped), so rejoin with `'\n'`.
fn range_slice(lines: &[&str], start: usize, end: usize) -> String {
    if start == 0 || start > lines.len() {
        return String::new();
    }
    let s = start - 1;
    let e = end.min(lines.len());
    lines[s..e].join("\n")
}

/// Parse `body` and return its section ranges depth-first: the synthetic
/// `(text)` region leads when present, then the heading tree in document order
/// (which is pre-order for a heading tree). Empty when the body has no headings
/// and no pre-heading prose.
///
/// Line numbers are relative to `body`. A caller holding a body cut from a file
/// adds the newlines before the cut to reach the file's lines.
pub fn section_ranges(body: &str) -> Vec<SectionRange> {
    let lines: Vec<&str> = crate::mdfacet::lines(body);
    let total = lines.len();

    // The 1-based line at which the body begins, i.e. the line after the closing
    // frontmatter `---`. Without frontmatter the body begins at line 1.
    let body_start = crate::frontmatter::body_start_line(body);

    // First pass: the body's ATX headings (level, line) from the mdstruct locator
    // facet. comrak already excludes a `#` inside a code fence or the frontmatter
    // block, so the old fence-toggling scan is gone; the `body_start` guard still
    // drops any heading before the body (an unclosed frontmatter mdstruct does not
    // recognize but `body_start_line` counts as frontmatter).
    let raw: Vec<crate::mdfacet::BodyHeading> = crate::mdfacet::body_headings(body)
        .into_iter()
        .filter(|h| h.line >= body_start)
        .collect();

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
        && !range_slice(&lines, region_start, region_end)
            .trim()
            .is_empty()
    {
        let mut first_line = region_start;
        while first_line <= region_end
            && lines
                .get(first_line - 1)
                .is_none_or(|l| l.trim().is_empty())
        {
            first_line += 1;
        }
        ranges.push(SectionRange {
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

    // Document order is pre-order, so emitting here mirrors a depth-first flatten.
    for (i, h) in raw.iter().enumerate() {
        ranges.push(SectionRange {
            level: h.level,
            start: h.line,
            end: ends[i],
        });
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
        let levels: Vec<usize> = r.iter().map(|s| s.level).collect();
        assert_eq!(levels, [0, 1, 2, 1]);
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
        assert_eq!(r[0].level, 0);
        assert_eq!((r[0].start, r[0].end), (1, 2));
    }

    #[test]
    fn hash_inside_fence_is_not_a_heading() {
        let body = "# Real\n```\n# fake\n```\ntail\n";
        let r = section_ranges(body);
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].level, r[0].start, r[0].end), (1, 1, 5));
    }

    #[test]
    fn frontmatter_is_skipped_before_body() {
        let body = "---\ntitle: x\n---\n# Heading\nbody\n";
        let r = section_ranges(body);
        // No text region (frontmatter is not prose); one heading at line 4.
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].level, r[0].start, r[0].end), (1, 4, 5));
    }
}
