use super::rule::Rule;

pub fn built_in_rules() -> Vec<Box<dyn Rule>> {
    vec![
        Box::new(super::rules::broken_wikilink::BrokenWikilink),
        Box::new(super::rules::dangling_reference::DanglingReference),
        Box::new(super::rules::orphan_card::OrphanCard),
        Box::new(super::rules::reference_not_wikilink::ReferenceNotWikilink),
        Box::new(super::rules::singleton_tag::SingletonTag),
        Box::new(super::rules::untagged_card::UntaggedCard),
    ]
}

pub fn rule_names() -> Vec<&'static str> {
    built_in_rules().iter().map(|r| r.name()).collect()
}
