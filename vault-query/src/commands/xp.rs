use anyhow::Result;
use chrono::{Datelike, NaiveDate, Weekday};
use regex::Regex;
use serde_yaml::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::config::ResolvedConfig;
use crate::frontmatter;
use crate::vault;

pub fn run(cfg: &ResolvedConfig, year_override: Option<i32>) -> Result<()> {
    let today = chrono::Local::now().date_naive();
    let year = year_override.unwrap_or(today.year());

    let data = parse_weekly_logs(&cfg.vault_root)?;
    let (_streak, day_streak) = compute_streak(&data.sleep_dates, today);
    let calendar = render_calendar(year, &data, &day_streak, today);
    println!("{}", calendar);
    Ok(())
}

#[derive(Debug, Default)]
pub struct LogData {
    pub day_tasks: HashMap<String, i32>,
    pub day_bonus: HashMap<String, i32>,
    pub sleep_dates: HashSet<String>,
}

pub fn parse_weekly_logs(vault_root: &Path) -> Result<LogData> {
    let mut data = LogData::default();

    let task_re = Regex::new(r"^\s*- \[x\] \((\d{4}-\d{2}-\d{2})\)").unwrap();
    let wikilink_re = Regex::new(r"\[\[([^\]|]*)\]\]").unwrap();

    let files = vault::scan(vault_root)?;
    let mut weekly_logs: Vec<&vault::VaultFile> = files
        .iter()
        .filter(|f| {
            frontmatter::get_display(&f.frontmatter, "type") == "weekly-log"
                && frontmatter::get_bool(&f.frontmatter, "template") != Some(true)
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

        if !projects.is_empty() && !done_links.is_empty() && !week_id.is_empty() {
            if projects.iter().all(|p| done_links.contains(p)) {
                if let Some(monday) = week_monday(&week_id) {
                    let next_monday = monday + chrono::Days::new(7);
                    let key = next_monday.format("%Y-%m-%d").to_string();
                    *data.day_bonus.entry(key).or_insert(0) += projects.len() as i32;
                }
            }
        }

        data.sleep_dates.extend(sleep_dates);
    }

    Ok(data)
}

fn sleep_dates(fm: &std::collections::BTreeMap<String, Value>) -> Vec<String> {
    match fm.get("sleep") {
        Some(Value::Sequence(arr)) => arr
            .iter()
            .filter_map(|v| match v {
                Value::String(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
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

fn week_monday(week_str: &str) -> Option<NaiveDate> {
    let re = Regex::new(r"(\d{4})-[Ww](\d{2})").ok()?;
    let caps = re.captures(week_str)?;
    let year: i32 = caps[1].parse().ok()?;
    let week: u32 = caps[2].parse().ok()?;
    NaiveDate::from_isoywd_opt(year, week, Weekday::Mon)
}

pub fn compute_streak(
    sleep_dates: &HashSet<String>,
    today: NaiveDate,
) -> (usize, HashMap<String, usize>) {
    let mut streak_dates = Vec::new();
    let mut i = 1u64;
    loop {
        let check = (today - chrono::Days::new(i)).format("%Y-%m-%d").to_string();
        if !sleep_dates.contains(&check) {
            break;
        }
        streak_dates.push(check);
        i += 1;
    }
    let today_str = today.format("%Y-%m-%d").to_string();
    if sleep_dates.contains(&today_str) {
        streak_dates.push(today_str);
    }

    let streak = streak_dates.len();
    let mut day_streak = HashMap::new();
    streak_dates.sort();
    for (i, sd) in streak_dates.iter().enumerate() {
        day_streak.insert(sd.clone(), (i + 1).min(7));
    }

    (streak, day_streak)
}

pub fn render_calendar(
    year: i32,
    data: &LogData,
    day_streak: &HashMap<String, usize>,
    today: NaiveDate,
) -> String {
    let dim = "\x1b[2m";
    let reset = "\x1b[0m";
    let green = "\x1b[32m";

    let dark_mode = detect_dark_mode();
    let cur_bg = if dark_mode {
        "\x1b[48;2;53;49;41m"
    } else {
        "\x1b[48;2;241;239;221m"
    };

    let is_current_year = year == today.year();
    let cur_month = today.month();
    let mut out = Vec::new();

    if is_current_year {
        let day_of_year = today.ordinal();
        let days_in_year = NaiveDate::from_ymd_opt(year, 12, 31)
            .unwrap()
            .ordinal();
        let pct = day_of_year * 100 / days_in_year;
        out.push(format!("\n{} ({}%)\n", year, pct));
    } else {
        out.push(format!("\n{}\n", year));
    }

    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let mut year_total = 0i32;

    for m in 1..=12u32 {
        let month_name = months[(m - 1) as usize];
        let dim_count = days_in_month(year, m);

        let past_month = is_current_year && m < cur_month;
        let future_month = is_current_year && m > cur_month;
        let current_month = is_current_year && m == cur_month;

        let mut date_strs = Vec::new();
        let mut day_xps = Vec::new();
        let mut month_total = 0i32;

        for d in 1..=dim_count {
            let ds = format!("{:04}-{:02}-{:02}", year, m, d);
            let tasks = data.day_tasks.get(&ds).copied().unwrap_or(0);
            let bonus = data.day_bonus.get(&ds).copied().unwrap_or(0);
            let streak_val = day_streak.get(&ds).copied().unwrap_or(0) as i32;
            let dxp = tasks + bonus + streak_val;
            date_strs.push(ds);
            day_xps.push(dxp);
            month_total += dxp;
        }
        year_total += month_total;

        // Header row
        let mut hdr = String::new();
        if past_month {
            hdr.push_str(dim);
            hdr.push_str(month_name);
            for d in 1..=dim_count {
                hdr.push_str(&format!(" {:2}", d));
            }
            hdr.push_str(reset);
        } else {
            hdr.push_str(month_name);
            let today_str = today.format("%Y-%m-%d").to_string();
            for (i, ds) in date_strs.iter().enumerate() {
                let d = i as u32 + 1;
                if *ds == today_str {
                    hdr.push_str(&format!(" {}{:2}{}", green, d, reset));
                } else if *ds < today_str {
                    hdr.push_str(&format!(" {}{:2}{}", dim, d, reset));
                } else {
                    hdr.push_str(&format!(" {:2}", d));
                }
            }
        }
        if current_month {
            hdr = format!(
                "{}{}{}",
                cur_bg,
                hdr.replace(reset, &format!("{}{}", reset, cur_bg)),
                reset
            );
        }
        out.push(hdr);

        // Data row
        if !(future_month && month_total == 0) {
            let mut drow = if past_month {
                format!("{}{:3}", dim, month_total)
            } else {
                format!("{:3}", month_total)
            };

            let today_str = today.format("%Y-%m-%d").to_string();
            for (i, ds) in date_strs.iter().enumerate() {
                let dxp = day_xps[i];
                if dxp > 0 {
                    if past_month || *ds < today_str {
                        drow.push_str(&format!("{} {:2}{}", dim, dxp, reset));
                    } else {
                        drow.push_str(&format!(" {:2}", dxp));
                    }
                } else if *ds > today_str {
                    drow.push_str("   ");
                } else {
                    drow.push_str(&format!("{}  \u{00d7}{}", dim, reset));
                }
            }
            if past_month {
                drow.push_str(reset);
            }
            if current_month {
                drow = format!(
                    "{}{}{}",
                    cur_bg,
                    drow.replace(reset, &format!("{}{}", reset, cur_bg)),
                    reset
                );
            }
            out.push(drow);
        } else {
            out.push(String::new());
        }
    }

    let level = year_total / 50;
    out.push(format!(
        "Streak: {}   Level: {}   Total: {} XP",
        compute_streak_count(&data.sleep_dates, today),
        level,
        year_total
    ));

    out.join("\n")
}

fn compute_streak_count(sleep_dates: &HashSet<String>, today: NaiveDate) -> usize {
    let (streak, _) = compute_streak(sleep_dates, today);
    streak
}

fn days_in_month(year: i32, month: u32) -> u32 {
    if month == 12 {
        31
    } else {
        let next = NaiveDate::from_ymd_opt(year, month + 1, 1).unwrap();
        let this = NaiveDate::from_ymd_opt(year, month, 1).unwrap();
        (next - this).num_days() as u32
    }
}

fn detect_dark_mode() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "Dark")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
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

        let data = parse_weekly_logs(tmp.path()).unwrap();
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

        let data = parse_weekly_logs(tmp.path()).unwrap();
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

        let data = parse_weekly_logs(tmp.path()).unwrap();
        assert!(data.day_bonus.is_empty());
    }

    #[test]
    fn test_streak() {
        let today = date(2026, 3, 16);
        let mut sleep = HashSet::new();
        sleep.insert("2026-03-15".to_string());
        sleep.insert("2026-03-14".to_string());
        sleep.insert("2026-03-16".to_string());

        let (streak, day_streak) = compute_streak(&sleep, today);
        assert_eq!(streak, 3);
        assert_eq!(day_streak.get("2026-03-14"), Some(&1));
        assert_eq!(day_streak.get("2026-03-15"), Some(&2));
        assert_eq!(day_streak.get("2026-03-16"), Some(&3));
    }

    #[test]
    fn test_streak_gap() {
        let today = date(2026, 3, 16);
        let mut sleep = HashSet::new();
        sleep.insert("2026-03-14".to_string());
        // Gap on 15th
        sleep.insert("2026-03-16".to_string());

        let (streak, _) = compute_streak(&sleep, today);
        assert_eq!(streak, 1); // Only today counts
    }

    #[test]
    fn test_calendar_contains_months() {
        let data = LogData::default();
        let day_streak = HashMap::new();
        let today = date(2026, 3, 16);
        let output = render_calendar(2026, &data, &day_streak, today);
        assert!(output.contains("Jan"));
        assert!(output.contains("Dec"));
        assert!(output.contains("2026"));
        assert!(output.contains("Streak:"));
        assert!(output.contains("Level:"));
        assert!(output.contains("Total:"));
    }

    #[test]
    fn test_calendar_year_percentage() {
        let data = LogData::default();
        let day_streak = HashMap::new();
        let today = date(2026, 3, 16);
        let output = render_calendar(2026, &data, &day_streak, today);
        // Day 75 of 365 ≈ 20%
        assert!(output.contains("2026 (20%)"));
    }

    #[test]
    fn test_week_monday() {
        let m = week_monday("2026-W10").unwrap();
        assert_eq!(m, date(2026, 3, 2));
    }
}
