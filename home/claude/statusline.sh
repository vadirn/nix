#!/bin/bash

# Two-line Claude Code Statusline
# Line 1: folder │ branch │ +/-diff (repo context)
# Line 2: model │ context%


main() {
    local input=$(cat) || exit 1

    # Parse JSON - workspace fields
    local current_dir=$(echo "$input" | grep -o '"current_dir"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
    [[ -z "$current_dir" ]] && exit 1
    [[ ! -d "$current_dir" ]] && exit 1

    # Parse model
    local model_name=$(echo "$input" | grep -o '"display_name"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)

    # Parse context window usage
    local used_pct=$(echo "$input" | grep -o '"used_percentage"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$')

    # Separator (dim gray)
    local sep=$(printf " \033[2;37m│\033[0m ")

    # === LINE 1: Repo Context ===

    # Folder (cyan)
    local folder_name=$(basename "$current_dir")
    local line1=$(printf "\033[36m%s\033[0m" "$folder_name")

    # Branch (magenta)
    if cd "$current_dir" 2>/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
        local branch=$(git branch --show-current 2>/dev/null)
        if [[ -n "$branch" ]]; then
            line1+=$(printf "%s\033[35m%s\033[0m" "$sep" "$branch")
        fi

        # Git diff stats: +X -Y (lines added/removed)
        local diff_stats=$(git diff --shortstat HEAD 2>/dev/null)
        local insertions=$(echo "$diff_stats" | grep -oE '[0-9]+ insertion' | grep -o '[0-9]*')
        local deletions=$(echo "$diff_stats" | grep -oE '[0-9]+ deletion' | grep -o '[0-9]*')
        insertions=${insertions:-0}
        deletions=${deletions:-0}

        # Add lines from untracked files
        local untracked_lines=$(git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 cat 2>/dev/null | wc -l | tr -d ' ')
        insertions=$((insertions + ${untracked_lines:-0}))

        if [[ $insertions -gt 0 || $deletions -gt 0 ]]; then
            line1+=$(printf "%s\033[32m+%s\033[0m \033[31m-%s\033[0m" "$sep" "$insertions" "$deletions")
        fi
    fi

    # === LINE 2: Session Metrics ===

    # Model (blue)
    local model_short="${model_name:-Unknown}"
    model_short="${model_short/Claude /}"
    model_short="${model_short/ Sonnet/}"
    model_short="${model_short/ Opus/}"
    local line2=$(printf "\033[34m%s\033[0m" "$model_short")

    # Context % (colored by usage)
    if [[ -n "$used_pct" ]]; then
        local color="32" # green
        [[ $used_pct -ge 40 ]] && color="33" # orange/yellow
        [[ $used_pct -ge 60 ]] && color="31" # red
        line2+=$(printf "%s\033[%sm%d%%\033[0m" "$sep" "$color" "$used_pct")
    fi

    # Output both lines
    printf "%s\n%s" "$line1" "$line2"
}

main
