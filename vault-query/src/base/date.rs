//! Calendar arithmetic for `.base` value rendering, kept free of the `chrono`
//! dependency.
//!
//! `file.ctime` is the only column that needs a date: it carries a Unix
//! timestamp that must render as `YYYY-MM-DD HH:MM`. [`format_timestamp`] does
//! that conversion by walking years and months off the epoch; [`is_leap`]
//! supplies the February length. Both lived inline in `view` before; they sit
//! here so the view layer stays about layout, not date math.

/// Render a Unix timestamp (seconds since 1970-01-01 UTC) as `YYYY-MM-DD HH:MM`.
pub fn format_timestamp(secs: u64) -> String {
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let minutes = (time_secs % 3600) / 60;

    // Days since 1970-01-01
    let mut y = 1970i64;
    let mut remaining_days = days as i64;
    loop {
        let days_in_year = if is_leap(y) { 366 } else { 365 };
        if remaining_days < days_in_year {
            break;
        }
        remaining_days -= days_in_year;
        y += 1;
    }
    let months = [31, if is_leap(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    for &days_in_month in &months {
        if remaining_days < days_in_month {
            break;
        }
        remaining_days -= days_in_month;
        m += 1;
    }
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}",
        y,
        m + 1,
        remaining_days + 1,
        hours,
        minutes
    )
}

/// Whether `y` is a Gregorian leap year.
pub fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_timestamp() {
        // 2024-01-01 00:00 UTC = 1704067200
        let s = format_timestamp(1704067200);
        assert_eq!(s, "2024-01-01 00:00");
    }

    #[test]
    fn test_is_leap() {
        assert!(is_leap(2024));
        assert!(is_leap(2000));
        assert!(!is_leap(1900));
        assert!(!is_leap(2023));
    }
}
