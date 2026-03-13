#!/usr/bin/env ruby
# frozen_string_literal: true

# XP report: calendar, streak, level. Called by vault-cli xp.

require "yaml"
require "date"
require "set"

TASK_RE = /^- \[x\] \((\d{4}-\d{2}-\d{2})\)/
WIKILINK_RE = /\[\[([^\]|]*)\]\]/

DIM    = "\033[2m"
RESET  = "\033[0m"
GREEN  = "\033[32m"
DARK_MODE = `defaults read -g AppleInterfaceStyle 2>/dev/null`.strip == "Dark"
CUR_BG = DARK_MODE ? "\033[48;2;53;49;41m" : "\033[48;2;241;239;221m"

def section_lines(text, heading)
  lines = text.lines.map(&:chomp)
  result = []
  in_section = false
  lines.each do |line|
    if line.match?(/^##\s+#{heading}/)
      in_section = true
      next
    end
    break if in_section && line.start_with?("## ")
    result << line if in_section
  end
  result
end

def week_monday(week_str)
  year, week = week_str.match(/(\d{4})-W(\d{2})/).captures.map(&:to_i)
  Date.commercial(year, week, 1)
end

vault_root = ARGV[0] || abort("Usage: vault-xp.rb <vault_root> [year]")
today = Date.today
year = (ARGV[1] || today.year).to_i
log_dir = File.join(vault_root, "41 projects", "block-buster")

day_tasks = Hash.new(0)
day_bonus = Hash.new(0)
sleep_dates = Set.new

Dir.glob(File.join(log_dir, "[0-9]*-w[0-9]*.md")).sort.each do |f|
  text = File.read(f)

  # Tasks: +1 each
  done_links = []
  section_lines(text, "Tasks").each do |line|
    m = line.match(TASK_RE)
    next unless m
    day_tasks[m[1]] += 1
    done_links.concat(line.scan(WIKILINK_RE).flatten)
  end

  # Backlog: -1 each
  section_lines(text, "Backlog").each do |line|
    m = line.match(TASK_RE)
    day_tasks[m[1]] -= 1 if m
  end

  # Coverage bonus
  projects = section_lines(text, "Projects").join("\n").scan(WIKILINK_RE).flatten
  fm = YAML.safe_load(text.split("---")[1] || "", permitted_classes: [Date]) || {}
  week_id = fm["week"].to_s

  if !projects.empty? && !done_links.empty? && !week_id.empty?
    if projects.all? { |p| done_links.include?(p) }
      monday = (week_monday(week_id) + 7).iso8601
      day_bonus[monday] += projects.size
    end
  end

  # Sleep dates
  sleep = fm["sleep"]
  case sleep
  when Array
    sleep_dates.merge(sleep.map { |d| d.is_a?(Date) ? d.iso8601 : d.to_s })
  end
end

# Streak: consecutive sleep days ending at today
streak_dates = []
si = 1
loop do
  check = (today - si).iso8601
  break unless sleep_dates.include?(check)
  streak_dates << check
  si += 1
end
streak_dates << today.iso8601 if sleep_dates.include?(today.iso8601)
streak = streak_dates.size

day_streak = {}
streak_dates.sort.each_with_index do |sd, i|
  day_streak[sd] = [i + 1, 7].min
end

# Render calendar
is_current_year = year == today.year
cur_month = today.month
out = []

if is_current_year
  day_of_year = today.yday
  days_in_year = Date.new(year, 12, 31).yday
  pct = day_of_year * 100 / days_in_year
  out << "\n#{year} (#{pct}%)\n"
else
  out << "\n#{year}\n"
end

months = %w[Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec]
year_total = 0

(1..12).each do |m|
  month_name = months[m - 1]
  dim_count = Date.new(year, m, -1).day

  past_month = is_current_year && m < cur_month
  future_month = is_current_year && m > cur_month
  current_month = is_current_year && m == cur_month

  date_strs = []
  day_xps = []
  month_total = 0
  (1..dim_count).each do |d|
    ds = format("%04d-%02d-%02d", year, m, d)
    date_strs << ds
    dxp = day_tasks[ds] + day_bonus[ds] + (day_streak[ds] || 0)
    day_xps << dxp
    month_total += dxp
  end
  year_total += month_total

  # Header row
  if past_month
    hdr = "#{DIM}#{month_name}"
    (1..dim_count).each { |d| hdr += format(" %2d", d) }
    hdr += RESET
  else
    hdr = month_name
    date_strs.each_with_index do |ds, i|
      d = i + 1
      hdr += if ds == today.iso8601
               format(" %s%2d%s", GREEN, d, RESET)
             elsif ds < today.iso8601
               format(" %s%2d%s", DIM, d, RESET)
             else
               format(" %2d", d)
             end
    end
  end
  if current_month
    hdr = "#{CUR_BG}#{hdr.gsub(RESET, RESET + CUR_BG)}#{RESET}"
  end
  out << hdr

  # Data row
  if !(future_month && month_total == 0)
    drow = if past_month
             "#{DIM}#{format("%3d", month_total)}"
           else
             format("%3d", month_total)
           end
    date_strs.each_with_index do |ds, i|
      dxp = day_xps[i]
      if dxp > 0
        drow += if past_month || ds < today.iso8601
                  "#{DIM}#{format(" %2d", dxp)}#{RESET}"
                else
                  format(" %2d", dxp)
                end
      elsif ds > today.iso8601
        drow += "   "
      else
        drow += "#{DIM}  \u00d7#{RESET}"
      end
    end
    drow += RESET if past_month
    if current_month
      drow = "#{CUR_BG}#{drow.gsub(RESET, RESET + CUR_BG)}#{RESET}"
    end
    out << drow
  else
    out << ""
  end
end

level = year_total / 50
out << "Streak: #{streak}   Level: #{level}   Total: #{year_total} XP"

puts out.join("\n")
