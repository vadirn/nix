//! The pure ANSI calendar renderer.
//!
//! [`render_calendar`] takes a `dark_mode: bool` instead of probing the OS, so
//! it is a pure function of its inputs (the probe lives in
//! [`super::theme::detect_dark_mode`], called from the `run` layer).

use chrono::{Datelike, NaiveDate};
use std::collections::HashMap;

use super::parse::LogData;
use super::streak::compute_streak_count;

/// Render the year's XP grid as an ANSI string. `dark_mode` selects the
/// current-month highlight colour; the renderer performs no I/O.
pub fn render_calendar(
    year: i32,
    data: &LogData,
    day_streak: &HashMap<String, usize>,
    today: NaiveDate,
    dark_mode: bool,
) -> String {
    let dim = "\x1b[2m";
    let reset = "\x1b[0m";
    let green = "\x1b[32m";

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
        // Dec 31 always exists for any in-range year, but fall back to a
        // non-leap count rather than unwrap-panicking on an out-of-range year.
        let days_in_year = NaiveDate::from_ymd_opt(year, 12, 31)
            .map(|d| d.ordinal())
            .unwrap_or(365);
        let pct = day_of_year * 100 / days_in_year;
        out.push(format!("\n{} ({}%)\n", year, pct));
    } else {
        out.push(format!("\n{}\n", year));
    }

    let months = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let today_str = today.format("%Y-%m-%d").to_string();
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

/// Number of days in `month` of `year`. Uses checked date construction so an
/// out-of-range year yields `0` (an empty month) rather than panicking.
fn days_in_month(year: i32, month: u32) -> u32 {
    if month == 12 {
        return 31;
    }
    match (
        NaiveDate::from_ymd_opt(year, month + 1, 1),
        NaiveDate::from_ymd_opt(year, month, 1),
    ) {
        (Some(next), Some(this)) => (next - this).num_days() as u32,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn test_calendar_contains_months() {
        let data = LogData::default();
        let day_streak = HashMap::new();
        let today = date(2026, 3, 16);
        let output = render_calendar(2026, &data, &day_streak, today, false);
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
        let output = render_calendar(2026, &data, &day_streak, today, false);
        // Day 75 of 365 ≈ 20%
        assert!(output.contains("2026 (20%)"));
    }

    #[test]
    fn test_calendar_dark_mode_selects_palette() {
        let data = LogData::default();
        let day_streak = HashMap::new();
        let today = date(2026, 3, 16);
        // The current-month highlight background differs between palettes.
        let dark = render_calendar(2026, &data, &day_streak, today, true);
        let light = render_calendar(2026, &data, &day_streak, today, false);
        assert!(dark.contains("\x1b[48;2;53;49;41m"));
        assert!(light.contains("\x1b[48;2;241;239;221m"));
        assert_ne!(dark, light);
    }

    #[test]
    fn test_days_in_month() {
        assert_eq!(days_in_month(2026, 1), 31);
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2024, 2), 29); // leap year
        assert_eq!(days_in_month(2026, 4), 30);
        assert_eq!(days_in_month(2026, 12), 31);
    }

    #[test]
    fn test_render_calendar_extreme_year_no_panic() {
        // An out-of-range year must degrade gracefully, not panic on the
        // unguarded Dec-31 / days_in_month date construction.
        let data = LogData::default();
        let day_streak = HashMap::new();
        let today = date(2026, 3, 16);
        let _ = render_calendar(i32::MAX, &data, &day_streak, today, false);
    }
}
