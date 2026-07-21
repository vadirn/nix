use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Format {
    Table,
    Json,
    Tsv,
}

impl FromStr for Format {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "table" => Ok(Format::Table),
            "json" => Ok(Format::Json),
            "tsv" => Ok(Format::Tsv),
            _ => Err(format!("unknown format: {}", s)),
        }
    }
}

impl std::fmt::Display for Format {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Format::Table => write!(f, "table"),
            Format::Json => write!(f, "json"),
            Format::Tsv => write!(f, "tsv"),
        }
    }
}

/// Two-variant output format shared by the read and search commands.
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
