//! The one parse every in-process guard reads: a Bash command cut into simple
//! commands the way the shell cuts it, each word with its quotes removed.
//!
//! It lexes; it never expands. `$VAR` stays as written and marks its word as
//! expanding. Text that runs as commands is parsed as commands too:
//! `$(...)`, backticks and `<(...)` inside words, the script after
//! `bash -c` or `eval`, and a heredoc fed to a shell. A heredoc fed to anything
//! else is data, and a `#` comment is dropped.
//!
//! Before this parse, each guard script split commands its own way: Python's
//! `shlex` over the whole command, a regex split, a hand-written quote scanner,
//! or a raw regex over the text. Reading one parse changes their decisions on
//! the edge cases where those splits disagree with the shell.

use std::ops::Range;

/// Substitutions nest at most this deep; deeper text is skipped unparsed.
const MAX_DEPTH: usize = 8;

/// Shells whose `-c` argument, or heredoc on stdin, is itself a script.
const SHELLS: &[&str] = &["bash", "sh", "zsh", "dash", "ksh"];

/// Reserved words that can open a simple command. They are split off the
/// front, so `if git push` and `do rm -rf x` still name their command first.
const KEYWORDS: &[&str] = &[
    "!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for",
    "case", "esac", "select", "function", "time", "coproc",
];

/// The operator that ends a simple command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// `|`
    Pipe,
    /// `|&`
    PipeAll,
    /// `&&`
    And,
    /// `||`
    Or,
    /// `;`, and the `;;` / `;&` that end a case branch
    Semi,
    /// `&`
    Amp,
    Newline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Origin {
    /// Written in the command itself, `( )` and `$( )` included: its words
    /// carry byte spans into the command.
    #[default]
    Source,
    /// Re-parsed from a string: backticks, `bash -c`, `eval`, a heredoc fed
    /// to a shell. No spans.
    Reparsed,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Word {
    /// The text with quotes and escapes removed; expansions stay as written.
    pub value: String,
    /// Byte range in the command, quotes included. `None` for reparsed text.
    pub span: Option<Range<usize>>,
    /// Some part was quoted or escaped.
    pub quoted: bool,
    /// The first character came from a quote or an escape.
    pub lead_quoted: bool,
    /// Holds `$(...)`, backticks or `<(...)`: expanding it runs a command.
    pub subst: bool,
    /// Holds any expansion: a parameter, arithmetic, or a substitution.
    pub expands: bool,
}

impl Word {
    /// The last path component: `/usr/bin/git` reads as `git`.
    pub fn base(&self) -> &str {
        self.value.rsplit('/').next().unwrap_or("")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Redirect {
    /// The file descriptor written before the operator, as in `2>`.
    pub fd: Option<String>,
    pub op: &'static str,
    pub target: Option<Word>,
    /// A heredoc's body, every line ending in a newline.
    pub body: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Segment {
    pub keywords: Vec<Word>,
    /// Leading `NAME=value` words.
    pub assigns: Vec<Word>,
    /// The command name, then its arguments.
    pub words: Vec<Word>,
    pub redirects: Vec<Redirect>,
    /// The operator that ends it: `None` at the end of the input or a group.
    pub op: Option<Op>,
    pub origin: Origin,
    /// 0 for the command itself; one more for each substitution or reparse.
    pub depth: usize,
    /// Inside `( )`.
    pub grouped: bool,
    /// Byte offset of its first token in the command. `None` for reparsed text.
    pub start: Option<usize>,
}

impl Segment {
    fn is_empty(&self) -> bool {
        self.keywords.is_empty()
            && self.assigns.is_empty()
            && self.words.is_empty()
            && self.redirects.is_empty()
    }
}

#[derive(Debug, Clone, Default)]
pub struct Script {
    /// Simple commands in source order. Those inside a substitution come
    /// before the command that holds it, as the shell runs them.
    pub segments: Vec<Segment>,
    /// A quote, substitution or group ran off the end of the input.
    pub incomplete: bool,
    /// A `#` comment was dropped.
    pub comments: bool,
}

pub fn parse(src: &str) -> Script {
    Parser::new(src.as_bytes(), true, false, 0).run()
}

/// The fallback a guard also reads when `parse` runs off the end: quotes,
/// escapes and parentheses are plain characters, and only blanks and the
/// operators `; & | < >` split. The scripts fell back the same way, to
/// `str.split()`, so an unbalanced quote never hides the words after it.
pub fn parse_literal(src: &str) -> Script {
    Parser::new(src.as_bytes(), true, true, 0).run()
}

enum Term {
    Eof,
    /// A `)` closing `$(` or `<(`.
    Paren,
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    spans: bool,
    literal: bool,
    depth: usize,
    out: Vec<Segment>,
    incomplete: bool,
    comments: bool,
    /// Heredocs whose body starts after the next newline: (segment, redirect).
    pending: Vec<(usize, usize)>,
}

fn blank(c: u8) -> bool {
    c == b' ' || c == b'\t'
}

/// `NAME=`, `NAME+=` or `NAME[i]=` at the front of an unquoted word.
fn is_assign(w: &Word) -> bool {
    if w.lead_quoted {
        return false;
    }
    let b = w.value.as_bytes();
    if !b
        .first()
        .is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
    {
        return false;
    }
    let mut k = 1;
    while k < b.len() && (b[k].is_ascii_alphanumeric() || b[k] == b'_') {
        k += 1;
    }
    if b.get(k) == Some(&b'[') {
        match b[k..].iter().position(|c| *c == b']') {
            Some(p) => k += p + 1,
            None => return false,
        }
    }
    if b.get(k) == Some(&b'+') {
        k += 1;
    }
    b.get(k) == Some(&b'=')
}

impl<'a> Parser<'a> {
    fn new(s: &'a [u8], spans: bool, literal: bool, depth: usize) -> Parser<'a> {
        Parser {
            s,
            i: 0,
            spans,
            literal,
            depth,
            out: Vec::new(),
            incomplete: false,
            comments: false,
            pending: Vec::new(),
        }
    }

    fn run(mut self) -> Script {
        self.list(Term::Eof);
        Script {
            segments: self.out,
            incomplete: self.incomplete,
            comments: self.comments,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn at(&self, k: usize) -> Option<u8> {
        self.s.get(self.i + k).copied()
    }

    fn blanks(&mut self) {
        while self.peek().is_some_and(blank) {
            self.i += 1;
        }
    }

    fn origin(&self) -> Origin {
        if self.spans {
            Origin::Source
        } else {
            Origin::Reparsed
        }
    }

    /// Reads simple commands until the end of input, or until the `)` that
    /// closes a substitution, which it consumes.
    fn list(&mut self, term: Term) {
        let mut seg = Segment::default();
        let mut raw: Vec<Word> = Vec::new();
        let mut group = 0usize;
        loop {
            self.blanks();
            let Some(c) = self.peek() else {
                if matches!(term, Term::Paren) || group > 0 {
                    self.incomplete = true;
                }
                self.end(&mut seg, &mut raw, None, group > 0);
                return;
            };
            let pos = self.i;
            match c {
                b'\\' if self.at(1) == Some(b'\n') && !self.literal => self.i += 2,
                b'\n' => {
                    self.i += 1;
                    self.end(&mut seg, &mut raw, Some(Op::Newline), group > 0);
                    self.heredocs();
                }
                b'#' if !self.literal => {
                    self.comments = true;
                    while self.peek().is_some_and(|c| c != b'\n') {
                        self.i += 1;
                    }
                }
                b';' => {
                    self.i += 1;
                    if matches!(self.peek(), Some(b';' | b'&')) {
                        self.i += 1;
                    }
                    self.end(&mut seg, &mut raw, Some(Op::Semi), group > 0);
                }
                b'&' if self.at(1) == Some(b'>') => {
                    self.start(&mut seg, pos);
                    let r = self.redirect(None);
                    seg.redirects.push(r);
                }
                b'&' => {
                    let op = if self.at(1) == Some(b'&') {
                        self.i += 2;
                        Op::And
                    } else {
                        self.i += 1;
                        Op::Amp
                    };
                    self.end(&mut seg, &mut raw, Some(op), group > 0);
                }
                b'|' => {
                    let op = match self.at(1) {
                        Some(b'|') => Op::Or,
                        Some(b'&') => Op::PipeAll,
                        _ => Op::Pipe,
                    };
                    self.i += if op == Op::Pipe { 1 } else { 2 };
                    self.end(&mut seg, &mut raw, Some(op), group > 0);
                }
                b'(' if !self.literal => {
                    self.i += 1;
                    self.end(&mut seg, &mut raw, None, group > 0);
                    group += 1;
                }
                b')' if !self.literal => {
                    self.i += 1;
                    self.end(&mut seg, &mut raw, None, group > 0);
                    if group > 0 {
                        group -= 1;
                    } else if matches!(term, Term::Paren) {
                        return;
                    }
                }
                b'<' | b'>' if self.literal || self.at(1) != Some(b'(') => {
                    self.start(&mut seg, pos);
                    let r = self.redirect(None);
                    seg.redirects.push(r);
                }
                _ => {
                    self.start(&mut seg, pos);
                    let w = self.word();
                    let fd = !w.quoted
                        && !w.value.is_empty()
                        && w.value.bytes().all(|b| b.is_ascii_digit())
                        && matches!(self.peek(), Some(b'<' | b'>'))
                        && self.at(1) != Some(b'(');
                    if fd {
                        let r = self.redirect(Some(w.value));
                        seg.redirects.push(r);
                    } else {
                        raw.push(w);
                    }
                }
            }
        }
    }

    fn start(&self, seg: &mut Segment, pos: usize) {
        if self.spans && seg.start.is_none() {
            seg.start = Some(pos);
        }
    }

    /// Closes the simple command being read: splits off its keywords and
    /// assignments, records its heredocs, and parses any script it hands to
    /// a shell.
    fn end(&mut self, seg: &mut Segment, raw: &mut Vec<Word>, op: Option<Op>, grouped: bool) {
        let mut s = std::mem::take(seg);
        let mut words = std::mem::take(raw).into_iter().peekable();
        while let Some(w) = words.peek() {
            if w.quoted || !KEYWORDS.contains(&w.value.as_str()) {
                break;
            }
            s.keywords.extend(words.next());
        }
        while words.peek().is_some_and(is_assign) {
            s.assigns.extend(words.next());
        }
        s.words.extend(words);
        if s.is_empty() {
            // `(a) | b`: the operator after a group ends the group's last command.
            if let Some(op) = op
                && op != Op::Newline
                && let Some(last) = self.out.last_mut()
                && last.op.is_none()
            {
                last.op = Some(op);
            }
            return;
        }
        s.op = op;
        s.grouped = grouped;
        s.origin = self.origin();
        s.depth = self.depth;
        let idx = self.out.len();
        if !self.literal {
            for (ri, r) in s.redirects.iter().enumerate() {
                if matches!(r.op, "<<" | "<<-") {
                    self.pending.push((idx, ri));
                }
            }
        }
        self.out.push(s);
        let scripts = shell_scripts(&self.out[idx]);
        for text in scripts {
            self.reparse(&text);
        }
    }

    /// Reads the bodies of the heredocs opened on the line just ended.
    fn heredocs(&mut self) {
        for (si, ri) in std::mem::take(&mut self.pending) {
            let r = &self.out[si].redirects[ri];
            let delim = r
                .target
                .as_ref()
                .map(|w| w.value.clone())
                .unwrap_or_default();
            let strip = r.op == "<<-";
            // Quoting any part of the delimiter turns expansion off.
            let expands = r.target.as_ref().is_some_and(|w| !w.quoted);
            let mut body = String::new();
            while self.i < self.s.len() {
                let end = self.s[self.i..]
                    .iter()
                    .position(|c| *c == b'\n')
                    .map_or(self.s.len(), |p| self.i + p);
                let line = &self.s[self.i..end];
                self.i = (end + 1).min(self.s.len());
                let cmp = if strip {
                    let tabs = line.iter().take_while(|c| **c == b'\t').count();
                    &line[tabs..]
                } else {
                    line
                };
                if cmp == delim.as_bytes() {
                    break;
                }
                body.push_str(&String::from_utf8_lossy(line));
                body.push('\n');
            }
            let feeds_shell = {
                let words = &self.out[si].words;
                words.iter().any(|w| SHELLS.contains(&w.base()))
                    && !words.iter().any(|w| is_c_flag(&w.value))
            };
            self.out[si].redirects[ri].body = Some(body.clone());
            if expands {
                self.expansions(&body);
            }
            if feeds_shell {
                self.reparse(&body);
            }
        }
    }

    /// Appends the commands an unquoted heredoc's body runs while it is
    /// expanded: `$(...)`, backticks, and those inside `${...}` or
    /// `$((...))`. The rest of the body is data, quotes included.
    fn expansions(&mut self, text: &str) {
        let mut p = Parser::new(text.as_bytes(), false, false, self.depth);
        let (mut v, mut w) = (Vec::new(), Word::default());
        while let Some(c) = p.peek() {
            match c {
                b'\\' => p.i = (p.i + 2).min(p.s.len()),
                b'$' => p.dollar(&mut v, &mut w, true),
                b'`' => p.backtick(&mut v, &mut w),
                _ => p.i += 1,
            }
        }
        self.incomplete |= p.incomplete;
        self.out.extend(p.out);
    }

    /// Parses a string that runs as commands, appending its segments.
    fn reparse(&mut self, text: &str) {
        if self.depth >= MAX_DEPTH {
            return;
        }
        let script = Parser::new(text.as_bytes(), false, false, self.depth + 1).run();
        self.incomplete |= script.incomplete;
        self.out.extend(script.segments);
    }

    fn redirect(&mut self, fd: Option<String>) -> Redirect {
        const OPS: &[&str] = &[
            "&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", "<", ">>", ">&", ">|", ">",
        ];
        let rest = &self.s[self.i..];
        let op = OPS
            .iter()
            .find(|o| rest.starts_with(o.as_bytes()))
            .copied()
            .unwrap_or(">");
        self.i += op.len();
        self.blanks();
        let target = match self.peek() {
            Some(c) if !b"\n;&|()<>".contains(&c) => Some(self.word()),
            _ => None,
        };
        Redirect {
            fd,
            op,
            target,
            body: None,
        }
    }

    fn word(&mut self) -> Word {
        let start = self.i;
        let mut w = Word::default();
        let mut v: Vec<u8> = Vec::new();
        while let Some(c) = self.peek() {
            if self.literal {
                if blank(c) || b"\n;&|<>".contains(&c) {
                    break;
                }
                v.push(c);
                self.i += 1;
                continue;
            }
            match c {
                b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')' => break,
                b'<' | b'>' => {
                    if v.is_empty() && self.at(1) == Some(b'(') {
                        let open = self.i;
                        self.i += 2;
                        self.nested();
                        v.extend_from_slice(&self.s[open..self.i]);
                        w.subst = true;
                        w.expands = true;
                        continue;
                    }
                    break;
                }
                b'\\' => match self.at(1) {
                    Some(b'\n') => self.i += 2,
                    Some(n) => {
                        quoted(&mut w, &v);
                        v.push(n);
                        self.i += 2;
                    }
                    None => {
                        v.push(b'\\');
                        self.i += 1;
                    }
                },
                b'\'' => {
                    quoted(&mut w, &v);
                    self.i += 1;
                    match self.s[self.i..].iter().position(|c| *c == b'\'') {
                        Some(p) => {
                            v.extend_from_slice(&self.s[self.i..self.i + p]);
                            self.i += p + 1;
                        }
                        None => {
                            v.extend_from_slice(&self.s[self.i..]);
                            self.i = self.s.len();
                            self.incomplete = true;
                        }
                    }
                }
                b'"' => {
                    quoted(&mut w, &v);
                    self.i += 1;
                    self.dquote(&mut v, &mut w);
                }
                b'$' => self.dollar(&mut v, &mut w, false),
                b'`' => self.backtick(&mut v, &mut w),
                _ => {
                    v.push(c);
                    self.i += 1;
                }
            }
        }
        w.value = String::from_utf8_lossy(&v).into_owned();
        if self.spans {
            w.span = Some(start..self.i);
        }
        w
    }

    fn dquote(&mut self, v: &mut Vec<u8>, w: &mut Word) {
        loop {
            match self.peek() {
                None => {
                    self.incomplete = true;
                    return;
                }
                Some(b'"') => {
                    self.i += 1;
                    return;
                }
                Some(b'\\') => match self.at(1) {
                    Some(b'\n') => self.i += 2,
                    Some(n @ (b'$' | b'`' | b'"' | b'\\')) => {
                        v.push(n);
                        self.i += 2;
                    }
                    _ => {
                        v.push(b'\\');
                        self.i += 1;
                    }
                },
                Some(b'$') => self.dollar(v, w, true),
                Some(b'`') => self.backtick(v, w),
                Some(c) => {
                    v.push(c);
                    self.i += 1;
                }
            }
        }
    }

    /// Reads one `$` form at the cursor. Expansions keep their source text.
    fn dollar(&mut self, v: &mut Vec<u8>, w: &mut Word, in_dquote: bool) {
        let open = self.i;
        match self.at(1) {
            Some(b'(') if self.at(2) == Some(b'(') => {
                let end = self.balanced(open + 1, b'(', b')');
                if end >= open + 5 && self.s.get(end - 2) == Some(&b')') {
                    // Arithmetic, which closes with `))`. A substitution
                    // inside it still runs, and the word counts as one, as
                    // the pipe-allow script refused any `$(`.
                    self.i = end;
                    let inner = self.s[open + 3..end - 2].to_vec();
                    self.inner_commands(&inner);
                } else {
                    // `$((a); b)`: a command substitution opening with a group.
                    self.i += 2;
                    self.nested();
                }
                w.subst = true;
                w.expands = true;
            }
            Some(b'(') => {
                self.i += 2;
                self.nested();
                w.subst = true;
                w.expands = true;
            }
            Some(b'{') => {
                let end = self.balanced(open + 1, b'{', b'}');
                self.i = end;
                let close = if end > open + 2 && self.s.get(end - 1) == Some(&b'}') {
                    end - 1
                } else {
                    end
                };
                let inner = self.s[(open + 2).min(close)..close].to_vec();
                // `${X:-$(cmd)}` runs cmd.
                if self.inner_commands(&inner) {
                    w.subst = true;
                }
                w.expands = true;
            }
            Some(b'\'') if !in_dquote => {
                quoted(w, v);
                self.i += 2;
                self.ansi_c(v);
                return;
            }
            Some(b'"') if !in_dquote => {
                // A locale string: the `"` that follows is read as usual.
                self.i += 1;
                return;
            }
            Some(c) if c.is_ascii_alphabetic() || c == b'_' => {
                self.i += 2;
                while self
                    .peek()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_')
                {
                    self.i += 1;
                }
                w.expands = true;
            }
            Some(c) if c.is_ascii_digit() || b"@*#?-$!".contains(&c) => {
                self.i += 2;
                w.expands = true;
            }
            _ => self.i += 1,
        }
        v.extend_from_slice(&self.s[open..self.i]);
    }

    /// The index just past the bracket matching the one at `open`.
    fn balanced(&mut self, open: usize, l: u8, r: u8) -> usize {
        let mut depth = 0usize;
        let mut k = open;
        while k < self.s.len() {
            if self.s[k] == l {
                depth += 1;
            } else if self.s[k] == r {
                depth -= 1;
                if depth == 0 {
                    return k + 1;
                }
            }
            k += 1;
        }
        self.incomplete = true;
        self.s.len()
    }

    /// Parses the substitutions inside the body of `${...}` or `$((...))`
    /// and appends their commands, dropping the body itself, which is not a
    /// command. Returns whether the body holds a substitution.
    fn inner_commands(&mut self, text: &[u8]) -> bool {
        let has = text.windows(2).any(|p| p == b"$(") || text.contains(&b'`');
        if !has || self.depth >= MAX_DEPTH {
            return has;
        }
        let body = self.depth + 1;
        let script = Parser::new(text, false, false, body).run();
        self.incomplete |= script.incomplete;
        self.out
            .extend(script.segments.into_iter().filter(|s| s.depth > body));
        true
    }

    /// Parses the commands of a `$(` or `<(` whose opening is consumed,
    /// through its closing `)`.
    fn nested(&mut self) {
        if self.depth >= MAX_DEPTH {
            self.i = self.balanced(self.i - 1, b'(', b')');
            return;
        }
        let saved = std::mem::take(&mut self.pending);
        self.depth += 1;
        self.list(Term::Paren);
        self.depth -= 1;
        self.pending = saved;
    }

    fn backtick(&mut self, v: &mut Vec<u8>, w: &mut Word) {
        let open = self.i;
        self.i += 1;
        let mut inner = Vec::new();
        loop {
            match self.peek() {
                None => {
                    self.incomplete = true;
                    break;
                }
                Some(b'`') => {
                    self.i += 1;
                    break;
                }
                Some(b'\\') if matches!(self.at(1), Some(b'`' | b'$' | b'\\')) => {
                    inner.push(self.s[self.i + 1]);
                    self.i += 2;
                }
                Some(c) => {
                    inner.push(c);
                    self.i += 1;
                }
            }
        }
        v.extend_from_slice(&self.s[open..self.i]);
        w.subst = true;
        w.expands = true;
        self.reparse(&String::from_utf8_lossy(&inner));
    }

    /// The body of `$'...'`, its opening consumed, with escapes decoded.
    fn ansi_c(&mut self, v: &mut Vec<u8>) {
        loop {
            let Some(c) = self.peek() else {
                self.incomplete = true;
                return;
            };
            self.i += 1;
            match c {
                b'\'' => return,
                b'\\' => {
                    let Some(e) = self.peek() else {
                        v.push(b'\\');
                        continue;
                    };
                    self.i += 1;
                    let simple = match e {
                        b'n' => Some(b'\n'),
                        b't' => Some(b'\t'),
                        b'r' => Some(b'\r'),
                        b'a' => Some(7),
                        b'b' => Some(8),
                        b'e' | b'E' => Some(27),
                        b'f' => Some(12),
                        b'v' => Some(11),
                        b'\\' | b'\'' | b'"' | b'?' => Some(e),
                        _ => None,
                    };
                    if let Some(b) = simple {
                        v.push(b);
                    } else if e == b'x' {
                        let mut n = 0u32;
                        let mut digits = 0;
                        while digits < 2 && self.peek().is_some_and(|c| c.is_ascii_hexdigit()) {
                            n = n * 16 + (self.s[self.i] as char).to_digit(16).unwrap_or(0);
                            self.i += 1;
                            digits += 1;
                        }
                        if digits == 0 {
                            v.extend_from_slice(b"\\x");
                        } else {
                            v.push(n as u8);
                        }
                    } else if (b'0'..=b'7').contains(&e) {
                        let mut n = (e - b'0') as u32;
                        let mut digits = 1;
                        while digits < 3 && self.peek().is_some_and(|c| (b'0'..=b'7').contains(&c))
                        {
                            n = n * 8 + (self.s[self.i] - b'0') as u32;
                            self.i += 1;
                            digits += 1;
                        }
                        v.push(n as u8);
                    } else {
                        v.push(b'\\');
                        v.push(e);
                    }
                }
                _ => v.push(c),
            }
        }
    }
}

/// Marks a word quoted, and lead-quoted when nothing came before.
fn quoted(w: &mut Word, v: &[u8]) {
    if v.is_empty() && !w.quoted {
        w.lead_quoted = true;
    }
    w.quoted = true;
}

/// `-c`, or a cluster of letters holding it such as `-lc` or `-ec`.
fn is_c_flag(s: &str) -> bool {
    s.len() > 1
        && s.starts_with('-')
        && !s.starts_with("--")
        && s[1..].bytes().all(|b| b.is_ascii_alphabetic())
        && s[1..].contains('c')
}

/// The scripts a simple command hands to a shell to run: the argument after
/// a shell's `-c`, and everything after `eval`.
fn shell_scripts(seg: &Segment) -> Vec<String> {
    let w = &seg.words;
    let mut out = Vec::new();
    for (k, word) in w.iter().enumerate() {
        if word.base() == "eval" {
            let rest: Vec<&str> = w[k + 1..].iter().map(|x| x.value.as_str()).collect();
            if !rest.is_empty() {
                out.push(rest.join(" "));
            }
            break;
        }
        if !SHELLS.contains(&word.base()) {
            continue;
        }
        let mut j = k + 1;
        while j < w.len() {
            let a = w[j].value.as_str();
            if is_c_flag(a) {
                if let Some(script) = w.get(j + 1) {
                    out.push(script.value.clone());
                }
                break;
            }
            if a == "-o" || a == "+o" {
                j += 2;
                continue;
            }
            if !a.starts_with('-') && !a.starts_with('+') {
                break;
            }
            j += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &Segment) -> Vec<&str> {
        s.words.iter().map(|w| w.value.as_str()).collect()
    }

    fn all(src: &str) -> Vec<Vec<String>> {
        parse(src)
            .segments
            .iter()
            .map(|s| s.words.iter().map(|w| w.value.clone()).collect())
            .collect()
    }

    #[test]
    fn operators_split_outside_quotes_only() {
        assert_eq!(
            all("a 'b | c' && d \"e;f\" | g & h; i || j"),
            [
                vec!["a", "b | c"],
                vec!["d", "e;f"],
                vec!["g"],
                vec!["h"],
                vec!["i"],
                vec!["j"]
            ]
        );
        let s = parse("a&&b|c");
        let ops: Vec<_> = s.segments.iter().map(|s| s.op).collect();
        assert_eq!(ops, [Some(Op::And), Some(Op::Pipe), None]);
        assert_eq!(all("x\ny"), [vec!["x"], vec!["y"]]);
    }

    #[test]
    fn quotes_and_escapes_come_off_the_value() {
        let s = parse(r#"echo 'a b' "c \"d\" \$e \q" f\ g $'h\ti' "#);
        assert_eq!(
            words(&s.segments[0]),
            ["echo", "a b", "c \"d\" $e \\q", "f g", "h\ti"]
        );
        let w = &s.segments[0].words[1];
        assert!(w.quoted && w.lead_quoted && !w.expands);
        assert_eq!(w.span, Some(5..10));
    }

    #[test]
    fn comments_drop_to_the_end_of_the_line() {
        let s = parse("sudo reboot #'\nls a#b");
        assert!(s.comments && !s.incomplete);
        assert_eq!(words(&s.segments[0]), ["sudo", "reboot"]);
        assert_eq!(words(&s.segments[1]), ["ls", "a#b"]);
        assert!(!parse("echo $# ${#x} '#'").comments);
    }

    #[test]
    fn keywords_and_assignments_split_off_the_front() {
        let s = parse("if X=1 Y+=2 git push; then do_it; fi");
        assert_eq!(s.segments[0].keywords[0].value, "if");
        assert_eq!(s.segments[0].assigns.len(), 2);
        assert_eq!(words(&s.segments[0]), ["git", "push"]);
        assert_eq!(words(&s.segments[1]), ["do_it"]);
        assert!(parse("\"A=1\" cmd").segments[0].assigns.is_empty());
    }

    #[test]
    fn substitutions_are_parsed_as_commands() {
        let s = parse("echo \"$(git push)\" `rm -rf x` $(( 1 + 2 )) ${a:-b} <(cat .env)");
        let segs: Vec<Vec<&str>> = s.segments.iter().map(words).collect();
        assert_eq!(segs[0], ["git", "push"]);
        assert_eq!(segs[1], ["rm", "-rf", "x"]);
        assert_eq!(segs[2], ["cat", ".env"]);
        let echo = segs.last().unwrap();
        assert_eq!(echo[0], "echo");
        assert_eq!(echo[1], "$(git push)");
        assert_eq!(s.segments[0].depth, 1);
        assert_eq!(s.segments[1].origin, Origin::Reparsed);
        let echo = &s.segments.last().unwrap().words;
        assert!(echo[1].subst);
        // Arithmetic counts as a substitution; a plain default does not.
        assert!(echo[3].subst && echo[3].expands);
        assert!(!echo[4].subst && echo[4].expands);
    }

    #[test]
    fn substitutions_inside_parameter_and_arithmetic_expansions_run() {
        for src in [
            "echo ${X:-$(git push)}",
            "echo \"${X:-`git push`}\"",
            "echo $(( $(git push) + 1 ))",
            "echo $((git push); echo)",
        ] {
            let s = parse(src);
            let segs: Vec<Vec<&str>> = s.segments.iter().map(words).collect();
            assert!(segs.contains(&vec!["git", "push"]), "{src}: {segs:?}");
            assert!(
                !segs
                    .iter()
                    .any(|w| w.first().is_some_and(|c| c.starts_with('X')))
            );
            assert!(s.segments.last().unwrap().words[1].subst, "{src}");
        }
        let plain = parse("echo ${HOME:-/tmp} $((1 + 2))");
        assert_eq!(plain.segments.len(), 1);
        assert!(!plain.segments[0].words[1].subst);
        assert!(plain.segments[0].words[2].subst);
    }

    #[test]
    fn heredoc_bodies_are_data_unless_fed_to_a_shell() {
        let src = "git commit -m \"$(cat <<'EOF'\nfix(x): don't git push\nEOF\n)\" && ls";
        let s = parse(src);
        assert!(!s.incomplete);
        let segs: Vec<Vec<&str>> = s.segments.iter().map(words).collect();
        assert_eq!(
            segs,
            [
                vec!["cat"],
                vec!["git", "commit", "-m", &src[15..src.len() - 7]],
                vec!["ls"]
            ]
        );
        assert_eq!(
            s.segments[0].redirects[0].body.as_deref(),
            Some("fix(x): don't git push\n")
        );
        let fed = parse("bash <<EOF\ngit push\nEOF\necho done");
        let segs: Vec<Vec<&str>> = fed.segments.iter().map(words).collect();
        assert_eq!(
            segs,
            [vec!["bash"], vec!["git", "push"], vec!["echo", "done"]]
        );
        let tabs = parse("cat <<-X\n\tbody\n\tX\nnext");
        assert_eq!(words(&tabs.segments[1]), ["next"]);
    }

    #[test]
    fn an_unquoted_heredoc_runs_its_substitutions() {
        let src = "cat <<EOF | cat\nit's $(git push) and `rm -rf x`\n${X:-$(sudo ls)} \\$(not this)\nEOF\nls";
        let s = parse(src);
        assert!(!s.incomplete);
        let segs: Vec<Vec<&str>> = s.segments.iter().map(words).collect();
        for want in [
            vec!["git", "push"],
            vec!["rm", "-rf", "x"],
            vec!["sudo", "ls"],
        ] {
            assert!(segs.contains(&want), "{want:?} missing from {segs:?}");
        }
        assert!(!segs.iter().any(|w| w.first() == Some(&"not")));
        assert!(segs.iter().all(|w| !w.contains(&"it's")));
        // Quoting the delimiter, in any way, keeps the body data.
        for quoted in ["'EOF'", "\"EOF\"", "\\EOF", "E\"OF\""] {
            let s = parse(&format!("cat <<{quoted}\n$(git push)\nEOF"));
            assert_eq!(s.segments.len(), 1, "{quoted}");
        }
    }

    #[test]
    fn shell_c_and_eval_scripts_are_parsed() {
        let segs: Vec<Vec<String>> =
            all("bash -lc 'git push' ; sudo sh -o pipefail -c \"rm -rf /\"; eval git reset --hard");
        assert!(segs.contains(&vec!["git".into(), "push".into()]));
        assert!(segs.contains(&vec!["rm".into(), "-rf".into(), "/".into()]));
        assert!(segs.contains(&vec!["git".into(), "reset".into(), "--hard".into()]));
    }

    #[test]
    fn redirects_take_their_fd_and_target() {
        let s = parse("cmd 2>&1 >out <in &>/dev/null 3>> log x");
        let seg = &s.segments[0];
        assert_eq!(words(seg), ["cmd", "x"]);
        let r: Vec<(Option<&str>, &str, &str)> = seg
            .redirects
            .iter()
            .map(|r| {
                (
                    r.fd.as_deref(),
                    r.op,
                    r.target.as_ref().unwrap().value.as_str(),
                )
            })
            .collect();
        assert_eq!(
            r,
            [
                (Some("2"), ">&", "1"),
                (None, ">", "out"),
                (None, "<", "in"),
                (None, "&>", "/dev/null"),
                (Some("3"), ">>", "log")
            ]
        );
    }

    #[test]
    fn groups_mark_their_commands() {
        let s = parse("(cd x && rm -rf y) | wc");
        assert!(s.segments[0].grouped && s.segments[1].grouped);
        assert!(!s.segments[2].grouped);
        assert_eq!(s.segments[1].op, Some(Op::Pipe));
    }

    #[test]
    fn an_unbalanced_quote_is_incomplete_and_the_literal_parse_still_splits() {
        let s = parse("echo 'x && git push");
        assert!(s.incomplete);
        assert_eq!(s.segments.len(), 1);
        let l = parse_literal("echo 'x && git push");
        assert_eq!(words(&l.segments[1]), ["git", "push"]);
    }

    #[test]
    fn deep_nesting_stops_without_overflow() {
        let src = "$(".repeat(200) + &")".repeat(200);
        let s = parse(&src);
        assert!(s.segments.len() <= MAX_DEPTH + 1);
    }

    #[test]
    fn multibyte_text_survives_byte_splitting() {
        let s = parse("grep 'пароль' .env|wc");
        assert_eq!(words(&s.segments[0]), ["grep", "пароль", ".env"]);
    }
}
