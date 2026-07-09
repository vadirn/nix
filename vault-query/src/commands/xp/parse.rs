//! Scan the vault's weekly-log notes into per-day XP and the set of sleep dates.

use anyhow::Result;
use chrono::{NaiveDate, Weekday};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::config::ResolvedConfig;
use crate::frontmatter;
use crate::vault;

/// Per-day XP signals gathered across every weekly log.
#[derive(Debug, Default)]
pub struct LogData {
    pub day_tasks: HashMap<String, i32>,
    pub day_bonus: HashMap<String, i32>,
    pub sleep_dates: HashSet<String>,
}

pub fn parse_weekly_logs(cfg: &ResolvedConfig) -> Result<LogData> {
    let vault_root = &cfg.vault_root;
    let mut data = LogData::default();

    let task_re = Regex::new(r"^\s*- \[x\] \((\d{4}-\d{2}-\d{2})\)").unwrap();
    let wikilink_re = Regex::new(r"\[\[([^\]|]*)\]\]").unwrap();

    let files = vault::scan(vault_root, vault_root, Some(&cfg.ignore))?;
    let mut weekly_logs: Vec<&vault::VaultFile> = files
        .iter()
        .filter(|f| {
            frontmatter::get_display(&f.frontmatter, "type") == "weekly-log"
                && !frontmatter::is_template(&f.frontmatter)
        })
        .collect();
    weekly_logs.sort_by(|a, b| a.name.cmp(&b.name));

    for file in &weekly_logs {
        let text = &file.content;
        let week_id = frontmatter::get_display(&file.frontmatter, "week");
        let sleep_dates = sleep_dates(&file.frontmatter);

        // Tasks: +1 each
        let mut done_links = Vec::new();
        for line in section_lines(text, "Tasks") {
            if let Some(caps) = task_re.captures(&line) {
                let date = caps[1].to_string();
                *data.day_tasks.entry(date).or_insert(0) += 1;
                for caps in wikilink_re.captures_iter(&line) {
                    done_links.push(caps[1].to_string());
                }
            }
        }

        // Backlog: -1 each
        for line in section_lines(text, "Backlog") {
            if let Some(caps) = task_re.captures(&line) {
                let date = caps[1].to_string();
                *data.day_tasks.entry(date).or_insert(0) -= 1;
            }
        }

        // Coverage bonus
        let projects: Vec<String> = section_lines(text, "Projects")
            .iter()
            .flat_map(|line| wikilink_re.captures_iter(line))
            .map(|caps| caps[1].to_string())
            .collect();

        if !projects.is_empty()
            && !done_links.is_empty()
            && !week_id.is_empty()
            && projects.iter().all(|p| done_links.contains(p))
            && let Some(monday) = week_monday(&week_id)
        {
            let next_monday = monday + chrono::Days::new(7);
            let key = next_monday.format("%Y-%m-%d").to_string();
            *data.day_bonus.entry(key).or_insert(0) += projects.len() as i32;
        }

        data.sleep_dates.extend(sleep_dates);
    }

    Ok(data)
}

fn sleep_dates(fm: &std::collections::BTreeMap<String, serde_yaml::Value>) -> Vec<String> {
    let mut dates = frontmatter::get_string_seq(fm, "sleep");
    dates.retain(|s| !s.is_empty());
    dates
}

fn section_lines(text: &str, heading: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut in_section = false;

    for line in text.lines() {
        if line.starts_with("## ") && line[3..].trim() == heading {
            in_section = true;
            continue;
        }
        if in_section && line.starts_with("## ") {
            break;
        }
        if in_section {
            result.push(line.to_string());
        }
    }
    result
}

/// Monday of an ISO week id like `2026-W10`. Returns `None` when the id does not
/// parse or names a week that does not exist in that year (e.g. `W53` in a
/// 52-week ISO year): `from_isoywd_opt` rejects it rather than panicking.
fn week_monday(week_str: &str) -> Option<NaiveDate> {
    static WEEK_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(\d{4})-[Ww](\d{2})").unwrap());
    let caps = WEEK_RE.captures(week_str)?;
    let year: i32 = caps[1].parse().ok()?;
    let week: u32 = caps[2].parse().ok()?;
    NaiveDate::from_isoywd_opt(year, week, Weekday::Mon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_yaml::Value;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    fn cfg_for(vault: &std::path::Path) -> ResolvedConfig {
        ResolvedConfig {
            vault_root: vault.to_path_buf(),
            projects_path: None,
            project_path: None,
            log_project_path: crate::config::DEFAULT_LOG_PROJECT_PATH.to_string(),
            lint: None,
            consult: None,
            ignore: crate::vault_ignore::VaultIgnore::from_patterns(vec![]),
        }
    }

    #[test]
    fn test_section_lines() {
        let text = "---\nweek: 2026-W10\n---\n## Tasks\n- [x] (2026-03-02) task1\n- [ ] task2\n## Backlog\n- [x] (2026-03-03) old\n";
        let tasks = section_lines(text, "Tasks");
        assert_eq!(tasks.len(), 2);
        assert!(tasks[0].contains("task1"));

        let backlog = section_lines(text, "Backlog");
        assert_eq!(backlog.len(), 1);
    }

    #[test]
    fn test_sleep_dates() {
        let mut fm = std::collections::BTreeMap::new();
        fm.insert(
            "sleep".to_string(),
            Value::Sequence(vec![
                Value::String("2026-03-02".to_string()),
                Value::String("2026-03-03".to_string()),
                Value::String("".to_string()),
                Value::Null,
            ]),
        );
        let dates = sleep_dates(&fm);
        assert_eq!(dates.len(), 2);
        assert!(dates.contains(&"2026-03-02".to_string()));
        assert!(dates.contains(&"2026-03-03".to_string()));
    }

    #[test]
    fn test_parse_tasks() {
        let tmp = tempfile::tempdir().unwrap();
        let log_content = "\
---
type: weekly-log
week: 2026-W10
sleep: []
---
## Projects
- [[ProjectA]]
- [[ProjectB]]

## Tasks
- [x] (2026-03-02) did thing [[ProjectA]]
- [x] (2026-03-02) another [[ProjectB]]
- [ ] not done

## Backlog
- [x] (2026-03-03) backlog task
";
        std::fs::write(tmp.path().join("2026-w10.md"), log_content).unwrap();

        let cfg = cfg_for(tmp.path());
        let data = parse_weekly_logs(&cfg).unwrap();
        assert_eq!(data.day_tasks.get("2026-03-02"), Some(&2));
        assert_eq!(data.day_tasks.get("2026-03-03"), Some(&-1));
    }

    #[test]
    fn test_coverage_bonus() {
        let tmp = tempfile::tempdir().unwrap();
        let log_content = "\
---
type: weekly-log
week: 2026-W10
sleep: []
---
## Projects
- [[ProjectA]]

## Tasks
- [x] (2026-03-02) task [[ProjectA]]
";
        std::fs::write(tmp.path().join("2026-w10.md"), log_content).unwrap();

        let cfg = cfg_for(tmp.path());
        let data = parse_weekly_logs(&cfg).unwrap();
        // Bonus should land on Monday of W11 (2026-03-09)
        assert_eq!(data.day_bonus.get("2026-03-09"), Some(&1));
    }

    #[test]
    fn test_no_coverage_bonus_partial() {
        let tmp = tempfile::tempdir().unwrap();
        let log_content = "\
---
type: weekly-log
week: 2026-W10
sleep: []
---
## Projects
- [[ProjectA]]
- [[ProjectB]]

## Tasks
- [x] (2026-03-02) task [[ProjectA]]
";
        std::fs::write(tmp.path().join("2026-w10.md"), log_content).unwrap();

        let cfg = cfg_for(tmp.path());
        let data = parse_weekly_logs(&cfg).unwrap();
        assert!(data.day_bonus.is_empty());
    }

    #[test]
    fn test_week_monday() {
        let m = week_monday("2026-W10").unwrap();
        assert_eq!(m, date(2026, 3, 2));
    }

    #[test]
    fn test_week_monday_invalid_week53() {
        // 2021 is a 52-week ISO year, so W53 does not exist; week_monday must
        // return None rather than panic on the unguarded date construction.
        assert!(week_monday("2021-W53").is_none());
        // 2020 is a 53-week ISO year, so W53 there is valid.
        assert!(week_monday("2020-W53").is_some());
    }
}
