/// Rough token estimate shared by the consult packer, search result
/// enrichment, and the oversized-doc lint rule: one token per four characters.
/// Changing the formula here recalibrates all three sites together.
pub fn estimate_tokens(text: &str) -> usize {
    text.chars().count() / 4
}
