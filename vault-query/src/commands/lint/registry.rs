use super::rule::Rule;

pub fn built_in_rules() -> Vec<Box<dyn Rule>> {
    vec![Box::new(super::rules::orphan_card::OrphanCard)]
}

pub fn rule_names() -> Vec<&'static str> {
    built_in_rules().iter().map(|r| r.name()).collect()
}
