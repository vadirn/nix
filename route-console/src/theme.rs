//! The look: Rune's neutral tokens (`rune::tok`), plus the few the design
//! canvas derives from them (hover, zebra, selection and badge tints), which
//! tok.rs does not carry. Values are the canvas's own, for both appearances.

use rune::tok::{self, TextStyle};
use rune::{Color, oklch, oklcha};
use rune_kit::{Kit, TableStyle};

#[derive(Clone, Copy)]
pub struct Tokens {
    pub dark: bool,
    pub bg: Color,
    pub card: Color,
    pub card_border: Color,
    pub separator: Color,
    pub text: Color,
    pub text_secondary: Color,
    pub zebra: Color,
    pub fill: Color,
    pub sel: Color,
    pub inspector: Color,
    pub accent_text: Color,
    pub warn_bg: Color,
    pub warn_border: Color,
}

/// A badge's or bar's colour family.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tint {
    Gray,
    Blue,
    Purple,
    Pink,
    Orange,
}

pub mod ty {
    use super::TextStyle;
    use rune::tok::type_;
    pub const BODY: TextStyle = type_::BODY;
    pub const TITLE: TextStyle = type_::TITLE;
    pub const LABEL: TextStyle = type_::LABEL;
    pub const MONO: TextStyle = TextStyle::new(12.0, 400.0).mono().features("'tnum' 1");
    pub const MONO_LABEL: TextStyle = TextStyle::new(12.0, 500.0).mono();
    pub const MONO_BLOCK: TextStyle = TextStyle::new(12.0, 400.0).mono().lh(18.0);
    pub const NOTE: TextStyle = TextStyle::new(13.0, 400.0).lh(18.85);
}

impl Tokens {
    pub fn new(dark: bool) -> Tokens {
        let t = tok::theme(dark);
        if dark {
            Tokens {
                dark,
                bg: t.bg,
                card: t.card,
                card_border: t.card_border,
                separator: t.separator,
                text: t.text,
                text_secondary: t.text_secondary,
                zebra: oklcha(1.0, 0.0, 0.0, 0.02),
                fill: oklcha(1.0, 0.0, 0.0, 0.06),
                sel: oklcha(0.66, 0.17, 256.0, 0.26),
                inspector: oklch(0.212, 0.005, 265.0),
                accent_text: oklch(0.76, 0.13, 256.0),
                warn_bg: oklcha(0.74, 0.16, 58.0, 0.12),
                warn_border: oklcha(0.74, 0.16, 58.0, 0.32),
            }
        } else {
            Tokens {
                dark,
                bg: t.bg,
                card: t.card,
                card_border: t.card_border,
                separator: t.separator,
                text: t.text,
                text_secondary: t.text_secondary,
                zebra: oklcha(0.2, 0.01, 265.0, 0.03),
                fill: oklcha(0.2, 0.01, 265.0, 0.06),
                sel: oklcha(0.6, 0.17, 256.0, 0.16),
                inspector: oklch(0.985, 0.002, 265.0),
                accent_text: oklch(0.48, 0.17, 256.0),
                warn_bg: oklcha(0.68, 0.16, 58.0, 0.1),
                warn_border: oklcha(0.68, 0.16, 58.0, 0.3),
            }
        }
    }

    /// A badge's fill and text.
    pub fn badge(&self, tint: Tint) -> (Color, Color) {
        let d = self.dark;
        match tint {
            Tint::Gray => (
                if d {
                    oklcha(1.0, 0.0, 0.0, 0.08)
                } else {
                    oklcha(0.2, 0.01, 265.0, 0.07)
                },
                self.text_secondary,
            ),
            Tint::Blue => (
                if d {
                    oklcha(0.66, 0.17, 256.0, 0.2)
                } else {
                    oklcha(0.6, 0.17, 256.0, 0.14)
                },
                if d {
                    oklch(0.82, 0.1, 256.0)
                } else {
                    oklch(0.46, 0.16, 256.0)
                },
            ),
            Tint::Purple => (
                if d {
                    oklcha(0.66, 0.18, 300.0, 0.2)
                } else {
                    oklcha(0.6, 0.18, 300.0, 0.14)
                },
                if d {
                    oklch(0.82, 0.11, 300.0)
                } else {
                    oklch(0.46, 0.17, 300.0)
                },
            ),
            Tint::Pink => (
                if d {
                    oklcha(0.68, 0.19, 357.0, 0.2)
                } else {
                    oklcha(0.62, 0.19, 357.0, 0.14)
                },
                if d {
                    oklch(0.82, 0.11, 357.0)
                } else {
                    oklch(0.46, 0.17, 357.0)
                },
            ),
            Tint::Orange => (
                if d {
                    oklcha(0.74, 0.16, 58.0, 0.2)
                } else {
                    oklcha(0.68, 0.16, 58.0, 0.18)
                },
                if d {
                    oklch(0.84, 0.11, 58.0)
                } else {
                    oklch(0.46, 0.11, 58.0)
                },
            ),
        }
    }

    /// A timing bar's fill.
    pub fn bar(&self, tint: Tint) -> Color {
        match tint {
            Tint::Blue => tok::accent(0, self.dark),
            Tint::Purple => tok::accent(1, self.dark),
            Tint::Pink => tok::accent(2, self.dark),
            Tint::Orange => tok::accent(3, self.dark),
            Tint::Gray => {
                if self.dark {
                    oklcha(0.64, 0.012, 265.0, 0.5)
                } else {
                    oklcha(0.58, 0.012, 265.0, 0.45)
                }
            }
        }
    }

    /// The text of the rewrite target.
    pub fn rewrite_text(&self) -> Color {
        self.badge(Tint::Blue).1
    }

    /// rune-kit's neutral kit, with the canvas's card border and selection.
    pub fn kit(&self) -> Kit {
        let mut k = Kit::neutral(self.dark);
        k.c.page = self.bg;
        k.c.bg_deep = self.bg;
        k.c.bg_base = self.card;
        k.c.border_muted = self.card_border;
        k
    }

    /// The sidebar's rows as the canvas draws them, per the HIG: accent icons,
    /// full-strength labels, and the selection in the accent tint.
    pub fn sidebar_kit(&self, k: &Kit) -> Kit {
        let mut k = k.clone();
        k.c.pressed = self.sel;
        k.c.icon_base = self.accent_text;
        k.c.icon_muted = self.accent_text;
        k.c.text_muted = self.text;
        k
    }

    pub fn table(&self, k: &Kit) -> TableStyle {
        TableStyle {
            row_height: 28.0,
            header_height: 28.0,
            cell_pad: 6.0,
            font: ty::BODY,
            mono: ty::MONO,
            header_font: ty::LABEL,
            text: self.text,
            muted: self.text_secondary,
            header_text: self.text_secondary,
            rule: self.separator,
            selected: self.sel,
            stripe: self.zebra,
            ..TableStyle::from_kit(k)
        }
    }
}

/// The colour family a verdict or handler result reads in.
pub fn tint_of(word: &str) -> Tint {
    match word {
        "deny" | "block" | "stop" => Tint::Pink,
        "rewrite" => Tint::Blue,
        "context" => Tint::Purple,
        "ask" | "error" | "stderr" => Tint::Orange,
        _ => Tint::Gray,
    }
}
