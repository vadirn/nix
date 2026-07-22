//! Output format for the reader: text (default) or JSON.

use std::str::FromStr;

/// Two-variant output format for the overview and unfold renderers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextJson {
    Text,
    Json,
}

impl FromStr for TextJson {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "text" => Ok(TextJson::Text),
            "json" => Ok(TextJson::Json),
            _ => Err(format!("unknown format: {} (expected text or json)", s)),
        }
    }
}

impl std::fmt::Display for TextJson {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TextJson::Text => write!(f, "text"),
            TextJson::Json => write!(f, "json"),
        }
    }
}
