//! `xp`: render a year-at-a-glance XP calendar from the weekly logs.
//!
//! Split into four submodules — [`parse`] (scan weekly logs into per-day XP and
//! sleep dates), [`streak`] (consecutive-sleep streak math), [`calendar`] (the
//! pure ANSI renderer), and [`theme`] (OS dark-mode detection) — with [`run`]
//! the only public entry point. The OS dark-mode probe lives in this thin `run`
//! layer and is passed down as a `bool`, so the renderer stays pure and
//! testable.

mod calendar;
mod parse;
mod streak;
mod theme;

use anyhow::Result;
use chrono::Datelike;

use crate::config::ResolvedConfig;

use calendar::render_calendar;
use parse::parse_weekly_logs;
use streak::compute_streak;

pub fn run(cfg: &ResolvedConfig, year_override: Option<i32>) -> Result<()> {
    let today = chrono::Local::now().date_naive();
    let year = year_override.unwrap_or(today.year());

    let data = parse_weekly_logs(cfg)?;
    let (_streak, day_streak) = compute_streak(&data.sleep_dates, today);
    let dark_mode = theme::detect_dark_mode();
    let calendar = render_calendar(year, &data, &day_streak, today, dark_mode);
    println!("{}", calendar);
    Ok(())
}
