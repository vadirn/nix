use anyhow::{bail, Result};
use chrono::{Datelike, IsoWeek, NaiveDate, Weekday};

use crate::config::ResolvedConfig;

pub fn run(cfg: &ResolvedConfig, date_input: Option<&str>) -> Result<()> {
    let today = chrono::Local::now().date_naive();
    let week = resolve_log_date(date_input.unwrap_or(""), today)?;
    let (week_start, week_end) = week_start_end(week);

    let log_dir = cfg.vault_root.join("41 projects/block-buster");
    let week_str = format_week(week);
    let log_file = log_dir.join(format!("{}.md", week_str.to_lowercase()));

    if log_file.is_file() {
        println!("{}", log_file.display());
        return Ok(());
    }

    // Don't create files for past weeks
    if week_end < today {
        bail!(
            "no log for past week {} (ended {})",
            week_str,
            week_end
        );
    }

    let template_path = cfg.vault_root.join("templates/Weekly Log.md");
    if !template_path.is_file() {
        bail!("template not found: {}", template_path.display());
    }

    std::fs::create_dir_all(&log_dir)?;
    let template = std::fs::read_to_string(&template_path)?;

    let filled = fill_template(&template, &week_str, &week_start, &week_end);
    std::fs::write(&log_file, filled)?;
    println!("{}", log_file.display());
    Ok(())
}

fn fill_template(
    template: &str,
    week: &str,
    start: &NaiveDate,
    end: &NaiveDate,
) -> String {
    let mut result = String::new();
    for line in template.lines() {
        if line.starts_with("week:") && line.trim() == "week:" {
            result.push_str(&format!("week: {}", week));
        } else if line.starts_with("start:") && line.trim() == "start:" {
            result.push_str(&format!("start: {}", start));
        } else if line.starts_with("end:") && line.trim() == "end:" {
            result.push_str(&format!("end: {}", end));
        } else {
            result.push_str(line);
        }
        result.push('\n');
    }
    result
}

fn format_week(week: IsoWeek) -> String {
    format!("{}-W{:02}", week.year(), week.week())
}

pub fn resolve_log_date(input: &str, today: NaiveDate) -> Result<IsoWeek> {
    if input.is_empty() {
        return Ok(today.iso_week());
    }

    match input {
        "last" | "prev" => {
            let d = today - chrono::Days::new(7);
            Ok(d.iso_week())
        }
        "next" => {
            let d = today + chrono::Days::new(7);
            Ok(d.iso_week())
        }
        _ => {
            // Try YYYY-MM-DD
            if let Ok(d) = NaiveDate::parse_from_str(input, "%Y-%m-%d") {
                return Ok(d.iso_week());
            }

            // Try week formats: N, WN, YYYY-WNN, YYYYWNN
            if let Some(week) = parse_week_spec(input, today) {
                return Ok(week);
            }

            bail!("unknown date format '{}'", input);
        }
    }
}

fn parse_week_spec(input: &str, today: NaiveDate) -> Option<IsoWeek> {
    let input_upper = input.to_uppercase();

    // Pure number: "5" or "05"
    if let Ok(n) = input.parse::<u32>() {
        if n >= 1 && n <= 53 {
            return week_from_year_week(today.iso_week().year(), n);
        }
    }

    // "W5" or "W05"
    if let Some(rest) = input_upper.strip_prefix('W') {
        if let Ok(n) = rest.parse::<u32>() {
            if n >= 1 && n <= 53 {
                return week_from_year_week(today.iso_week().year(), n);
            }
        }
    }

    // "2025-W03" or "2025-w03"
    if input.len() >= 7 && input.as_bytes()[4] == b'-' {
        let year_str = &input[..4];
        let rest = &input_upper[5..];
        if let Some(wnum_str) = rest.strip_prefix('W') {
            if let (Ok(year), Ok(wnum)) = (year_str.parse::<i32>(), wnum_str.parse::<u32>()) {
                return week_from_year_week(year, wnum);
            }
        }
    }

    // "2025W03" or "2025w03"
    if input.len() >= 6 && input.as_bytes()[4].to_ascii_uppercase() == b'W' {
        let year_str = &input[..4];
        let wnum_str = &input[5..];
        if let (Ok(year), Ok(wnum)) = (year_str.parse::<i32>(), wnum_str.parse::<u32>()) {
            return week_from_year_week(year, wnum);
        }
    }

    None
}

fn week_from_year_week(year: i32, week: u32) -> Option<IsoWeek> {
    NaiveDate::from_isoywd_opt(year, week, Weekday::Mon).map(|d| d.iso_week())
}

pub fn week_start_end(week: IsoWeek) -> (NaiveDate, NaiveDate) {
    let monday =
        NaiveDate::from_isoywd_opt(week.year(), week.week(), Weekday::Mon).unwrap();
    let sunday =
        NaiveDate::from_isoywd_opt(week.year(), week.week(), Weekday::Sun).unwrap();
    (monday, sunday)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn test_empty_is_current_week() {
        let today = date(2026, 3, 16);
        let week = resolve_log_date("", today).unwrap();
        assert_eq!(week, today.iso_week());
    }

    #[test]
    fn test_last_prev() {
        let today = date(2026, 3, 16);
        let expected = date(2026, 3, 9).iso_week();
        assert_eq!(resolve_log_date("last", today).unwrap(), expected);
        assert_eq!(resolve_log_date("prev", today).unwrap(), expected);
    }

    #[test]
    fn test_next() {
        let today = date(2026, 3, 16);
        let expected = date(2026, 3, 23).iso_week();
        assert_eq!(resolve_log_date("next", today).unwrap(), expected);
    }

    #[test]
    fn test_bare_number() {
        let today = date(2026, 3, 16);
        let week = resolve_log_date("5", today).unwrap();
        assert_eq!(format_week(week), "2026-W05");
    }

    #[test]
    fn test_w_prefix() {
        let today = date(2026, 3, 16);
        let week = resolve_log_date("W5", today).unwrap();
        assert_eq!(format_week(week), "2026-W05");
        let week2 = resolve_log_date("w05", today).unwrap();
        assert_eq!(format_week(week2), "2026-W05");
    }

    #[test]
    fn test_full_iso_week() {
        let today = date(2026, 3, 16);
        let week = resolve_log_date("2025-W03", today).unwrap();
        assert_eq!(format_week(week), "2025-W03");
    }

    #[test]
    fn test_iso_week_no_dash() {
        let today = date(2026, 3, 16);
        let week = resolve_log_date("2025W03", today).unwrap();
        assert_eq!(format_week(week), "2025-W03");
    }

    #[test]
    fn test_date_to_week() {
        let today = date(2026, 3, 16);
        let week = resolve_log_date("2025-03-15", today).unwrap();
        // 2025-03-15 is a Saturday in W11
        let (start, end) = week_start_end(week);
        assert!(start <= date(2025, 3, 15));
        assert!(end >= date(2025, 3, 15));
    }

    #[test]
    fn test_unknown_format_error() {
        let today = date(2026, 3, 16);
        assert!(resolve_log_date("xyz", today).is_err());
    }

    #[test]
    fn test_week_start_end() {
        // 2026-W12: March 16-22
        let week = date(2026, 3, 16).iso_week();
        let (start, end) = week_start_end(week);
        assert_eq!(start, date(2026, 3, 16));
        assert_eq!(end, date(2026, 3, 22));
    }

    #[test]
    fn test_fill_template() {
        let template = "---\nweek:\nstart:\nend:\nsleep: []\n---\n# Weekly Log\n";
        let result = fill_template(
            template,
            "2026-W12",
            &date(2026, 3, 16),
            &date(2026, 3, 22),
        );
        assert!(result.contains("week: 2026-W12"));
        assert!(result.contains("start: 2026-03-16"));
        assert!(result.contains("end: 2026-03-22"));
    }
}
