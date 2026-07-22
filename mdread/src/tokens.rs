/// Rough token estimate: one token per four characters. Presentation policy the
/// reader owns (the fold thresholds are tuned against it), deliberately kept out
/// of the mdstruct structural core.
pub fn estimate_tokens(text: &str) -> usize {
    text.chars().count() / 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_is_zero_tokens() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn four_chars_per_token_floors() {
        // Integer division floors, so sub-token remainders are dropped.
        assert_eq!(estimate_tokens("abc"), 0); // 3 / 4
        assert_eq!(estimate_tokens("abcd"), 1); // 4 / 4
        assert_eq!(estimate_tokens("abcdefg"), 1); // 7 / 4
        assert_eq!(estimate_tokens("abcdefgh"), 2); // 8 / 4
    }

    #[test]
    fn counts_unicode_scalars_not_bytes() {
        // "тест" is 4 chars / 8 bytes; the estimate uses chars.
        assert_eq!(estimate_tokens("тест"), 1);
    }
}
