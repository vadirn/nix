//! Consecutive-sleep streak math over the gathered sleep dates.

use chrono::NaiveDate;
use std::collections::{HashMap, HashSet};

/// Walk backwards from `today` while sleep was logged, returning the streak
/// length and a per-day rank (1..=7, capped) used to colour the calendar.
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

/// The streak length alone, for the calendar footer.
pub(super) fn compute_streak_count(sleep_dates: &HashSet<String>, today: NaiveDate) -> usize {
    let (streak, _) = compute_streak(sleep_dates, today);
    streak
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
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
    fn test_streak_count_matches() {
        let today = date(2026, 3, 16);
        let mut sleep = HashSet::new();
        sleep.insert("2026-03-15".to_string());
        sleep.insert("2026-03-16".to_string());
        assert_eq!(compute_streak_count(&sleep, today), 2);
    }
}
