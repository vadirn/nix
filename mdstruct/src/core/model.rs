//! The pinned JSON structural-model schema ([[mdstruct-plan]] §2).
//!
//! One envelope, camelCase on the wire, one `span` primitive (half-open UTF-8
//! byte offsets serialized as a two-element array), `type` on every tagged node,
//! headings in exactly one array, a `regions[]` overlay, no polymorphic fields,
//! no emitted `raw` strings. The `#[derive(Serialize)]` representation IS the
//! contract — a consumer deserializes exactly what a Rust `Document` serialized.

use serde::{Serialize, Serializer, ser::SerializeTuple};

use super::region::Dangling;

/// Full `major.minor` schema contract version, carried in every envelope.
/// 1.1 (additive-minor over 1.0): `Inline::Wikilink` gained `target` + `alias`
/// so a consumer reconstructs `{target, alias}` off decoded strings instead of
/// slicing the (table-cell-unreliable) span.
pub const SCHEMA_VERSION: &str = "1.1";

/// Half-open UTF-8 byte span `[start, end)` — the sole slicing primitive.
/// Serializes as a two-element array `[start, end]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Span { start, end }
    }
    pub fn is_empty(&self) -> bool {
        self.start >= self.end
    }
}

impl Serialize for Span {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut t = s.serialize_tuple(2)?;
        t.serialize_element(&self.start)?;
        t.serialize_element(&self.end)?;
        t.end()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub schema_version: &'static str,
    pub source: Source,
    pub frontmatter: FrontMatter,
    pub headings: Vec<Heading>,
    pub nodes: Vec<Node>,
    pub inlines: Vec<Inline>,
    pub regions: Vec<Region>,
    /// Unpaired anchors (leftover opens / unmatched closes). Populated always,
    /// serialized never — surfaced only by `check`, never in NDJSON.
    #[serde(skip)]
    pub dangling: Vec<Dangling>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
}

/// Block span + format tag only; the body is NOT parsed (Decision 4).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontMatter {
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delimiter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span: Option<Span>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Byte at which the post-frontmatter body begins (distill slices here).
    pub body_start_byte: usize,
    /// 1-based line at which the body begins (vault-query's exact need).
    pub body_start_line: u32,
}

/// The sole home of heading data; a tree nested by heading level. NOT
/// duplicated into `nodes[]`. `sectionSpan` is synthesized (heading → last byte
/// before the next same-or-higher heading); comrak's sibling AST denies this.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    #[serde(rename = "type")]
    pub node_type: &'static str,
    pub level: u8,
    pub setext: bool,
    /// The ONE column any consumer reads (vault-query indent filter).
    pub start_col: usize,
    pub span: Span,
    /// Post-`#` text span (vault-query slugs THIS).
    pub text_span: Span,
    pub start_line: u32,
    pub end_line: u32,
    pub section_span: Span,
    pub section_end_line: u32,
    pub children: Vec<Heading>,
}

/// Flat doc-order, NON-heading blocks (distill's harvest feed). Container nodes
/// carry `children[]`, which is descriptive and EXCLUDED from total tiling.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Node {
    Paragraph {
        span: Span,
        start_line: u32,
        end_line: u32,
    },
    CodeBlock {
        fenced: bool,
        fence_char: Option<char>,
        fence_length: usize,
        info: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        info_span: Option<Span>,
        /// RAW inner body — NEVER comrak's `literal` (which strips fence_offset indent).
        body_span: Span,
        span: Span,
        start_line: u32,
        end_line: u32,
    },
    BlockQuote {
        span: Span,
        start_line: u32,
        end_line: u32,
        children: Vec<Node>,
    },
    List {
        ordered: bool,
        tight: bool,
        marker: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        start: Option<usize>,
        span: Span,
        start_line: u32,
        end_line: u32,
        children: Vec<Node>,
    },
    ListItem {
        #[serde(skip_serializing_if = "Option::is_none")]
        task: Option<bool>,
        span: Span,
        start_line: u32,
        end_line: u32,
        children: Vec<Node>,
    },
    Table {
        span: Span,
        start_line: u32,
        end_line: u32,
        children: Vec<Node>,
    },
    TableRow {
        header: bool,
        span: Span,
        start_line: u32,
        end_line: u32,
        children: Vec<Node>,
    },
    TableCell {
        span: Span,
        start_line: u32,
        end_line: u32,
    },
    ThematicBreak {
        span: Span,
        start_line: u32,
        end_line: u32,
    },
    HtmlBlock {
        span: Span,
        start_line: u32,
        end_line: u32,
    },
    FootnoteDefinition {
        label: String,
        span: Span,
        start_line: u32,
        end_line: u32,
        children: Vec<Node>,
    },
    /// CommonMark link reference definition (`[label]: dest`); comrak consumes
    /// it to metadata with NO AST node. Recovered by the gap-filler so its
    /// bytes tile and distill's `[^n]: url` citations are not lost.
    LinkReferenceDefinition {
        span: Span,
        start_line: u32,
        end_line: u32,
    },
    /// Freeze-gate diagnostic: a comrak top-level block the schema does not yet
    /// type. Emitted (not dropped) so total tiling stays whole and coverage
    /// enumeration can report it; never appears in a clean run.
    Unknown {
        kind: String,
        span: Span,
        start_line: u32,
        end_line: u32,
    },
}

/// Flat inlines: links + wikilinks + code spans, positioned. `type` (not
/// `kind`); wikilink target decomposed at top level (no polymorphic `target`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Inline {
    Link {
        url: String,
        title: Option<String>,
        text_span: Span,
        span: Span,
        start_line: u32,
    },
    Image {
        url: String,
        title: Option<String>,
        alt_span: Span,
        span: Span,
        start_line: u32,
    },
    Wikilink {
        /// Decoded link target: comrak's `WikiLink.url` (or, for an embed, the
        /// pre-pipe raw inner). The RELIABLE string a consumer reads instead of
        /// slicing `span`, whose bytes shift inside escaped-pipe table cells
        /// (Decision 19). (Schema 1.1.)
        target: String,
        page: String,
        heading: Option<String>,
        block: Option<String>,
        /// Decoded display alias, present exactly when a `|` separates the link
        /// (`Some("")` for the empty-pipe `[[X|]]`), absent for a no-pipe
        /// `[[X]]`. `alias_span` (comrak's display span) is `Some(page)` for a
        /// no-pipe link and so cannot signal a pipe; this field can. (1.1.)
        #[serde(skip_serializing_if = "Option::is_none")]
        alias: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        alias_span: Option<Span>,
        /// `![[…]]` — set by a core pre-pass, never read from the node (comrak
        /// emits no WikiLink for embeds).
        embed: bool,
        span: Span,
        start_line: u32,
    },
    Autolink {
        url: String,
        span: Span,
        start_line: u32,
    },
    CodeSpan {
        span: Span,
        start_line: u32,
    },
    FootnoteRef {
        label: String,
        span: Span,
        start_line: u32,
    },
}

/// Overlay entry (opt-in): a labelled annotation OVER a span. References spans
/// in the parsed content, may overlap nodes and other regions, EXCLUDED from
/// total tiling.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    #[serde(rename = "type")]
    pub node_type: &'static str,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<String>,
    pub span: Span,
    pub body_span: Span,
    pub start_line: u32,
    pub end_line: u32,
}

impl Document {
    /// Slice `source` by a [`Span`] — the sole slicing primitive, exposed so
    /// consumers reconstruct text without reaching into `span.start`/`span.end`.
    pub fn slice<'s>(&self, source: &'s str, span: Span) -> &'s str {
        &source[span.start..span.end]
    }
    pub fn frontmatter(&self) -> Option<&FrontMatter> {
        if self.frontmatter.present {
            Some(&self.frontmatter)
        } else {
            None
        }
    }
    pub fn body_start_line(&self) -> u32 {
        self.frontmatter.body_start_line
    }
    pub fn headings(&self) -> &[Heading] {
        &self.headings
    }
    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }
    pub fn inlines(&self) -> &[Inline] {
        &self.inlines
    }
    pub fn regions(&self) -> &[Region] {
        &self.regions
    }
}

/// The span carried by any tiled member of the structural partition
/// (frontmatter + headings + top-level nodes). Interior/child spans are not
/// tiled.
impl Node {
    pub fn span(&self) -> Span {
        match self {
            Node::Paragraph { span, .. }
            | Node::CodeBlock { span, .. }
            | Node::BlockQuote { span, .. }
            | Node::List { span, .. }
            | Node::ListItem { span, .. }
            | Node::Table { span, .. }
            | Node::TableRow { span, .. }
            | Node::TableCell { span, .. }
            | Node::ThematicBreak { span, .. }
            | Node::HtmlBlock { span, .. }
            | Node::FootnoteDefinition { span, .. }
            | Node::LinkReferenceDefinition { span, .. }
            | Node::Unknown { span, .. } => *span,
        }
    }

    /// A stable label for coverage enumeration.
    pub fn kind(&self) -> &str {
        match self {
            Node::Paragraph { .. } => "paragraph",
            Node::CodeBlock { .. } => "codeBlock",
            Node::BlockQuote { .. } => "blockQuote",
            Node::List { .. } => "list",
            Node::ListItem { .. } => "listItem",
            Node::Table { .. } => "table",
            Node::TableRow { .. } => "tableRow",
            Node::TableCell { .. } => "tableCell",
            Node::ThematicBreak { .. } => "thematicBreak",
            Node::HtmlBlock { .. } => "htmlBlock",
            Node::FootnoteDefinition { .. } => "footnoteDefinition",
            Node::LinkReferenceDefinition { .. } => "linkReferenceDefinition",
            Node::Unknown { kind, .. } => kind,
        }
    }

    /// `children[]` for the six container variants, empty for leaves. The one
    /// place the container set is named; consumers recurse via `n.children()`
    /// rather than re-matching.
    pub fn children(&self) -> &[Node] {
        match self {
            Node::BlockQuote { children, .. }
            | Node::List { children, .. }
            | Node::ListItem { children, .. }
            | Node::Table { children, .. }
            | Node::TableRow { children, .. }
            | Node::FootnoteDefinition { children, .. } => children,
            _ => &[],
        }
    }
}

impl Inline {
    pub fn span(&self) -> Span {
        match self {
            Inline::Link { span, .. }
            | Inline::Image { span, .. }
            | Inline::Wikilink { span, .. }
            | Inline::Autolink { span, .. }
            | Inline::CodeSpan { span, .. }
            | Inline::FootnoteRef { span, .. } => *span,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Inline::Link { .. } => "link",
            Inline::Image { .. } => "image",
            Inline::Wikilink { .. } => "wikilink",
            Inline::Autolink { .. } => "autolink",
            Inline::CodeSpan { .. } => "codeSpan",
            Inline::FootnoteRef { .. } => "footnoteRef",
        }
    }
}
