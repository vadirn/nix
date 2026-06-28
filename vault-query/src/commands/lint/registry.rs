use super::rule::Rule;

/// `per_doc_token_cap` parameterizes `oversized-entry` with the consult packer's
/// threshold (`ConsultConfig.per_doc_token_cap`), keeping one source of truth.
pub fn built_in_rules(per_doc_token_cap: usize) -> Vec<Box<dyn Rule>> {
    vec![
        Box::new(super::rules::broken_wikilink::BrokenWikilink),
        Box::new(super::rules::dangling_reference::DanglingReference),
        Box::new(super::rules::dangling_relation_label::DanglingRelationLabel),
        Box::new(super::rules::duplicate_h1::DuplicateH1),
        Box::new(super::rules::invalid_frontmatter::InvalidFrontmatter),
        Box::new(super::rules::missing_required_field::MissingRequiredField),
        Box::new(super::rules::orphan_card::OrphanCard),
        Box::new(super::rules::oversized_entry::OversizedEntry { per_doc_token_cap }),
        Box::new(super::rules::reference_not_wikilink::ReferenceNotWikilink),
        Box::new(super::rules::singleton_tag::SingletonTag),
        Box::new(super::rules::unknown_rel::UnknownRel),
        Box::new(super::rules::untagged_card::UntaggedCard),
        Box::new(super::rules::untyped_entry::UntypedEntry),
    ]
}

pub fn rule_names() -> Vec<&'static str> {
    // Dummy cap: only `.name()` is consulted here, never `.check()`.
    built_in_rules(0).iter().map(|r| r.name()).collect()
}
