#!/usr/bin/env bash
# Install/update/remove agent skills vendored into home/agents/skills/<name>/
# from upstream GitHub repos. See home/agents/scripts/README or the commit
# message for design rationale. Runs from the user shell — not Claude's sandbox.
set -euo pipefail

# ---- path resolution ----

resolve_path() {
  local cur="$1" link
  while [ -L "$cur" ]; do
    link="$(readlink "$cur")"
    case "$link" in
      /*) cur="$link" ;;
      *)  cur="$(cd "$(dirname "$cur")" && cd "$(dirname "$link")" && pwd -P)/$(basename "$link")" ;;
    esac
  done
  printf '%s/%s\n' "$(cd "$(dirname "$cur")" && pwd -P)" "$(basename "$cur")"
}

SCRIPT_PATH="$(resolve_path "$0")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/../../.." && pwd -P)"
SKILLS_DIR="$REPO_ROOT/home/agents/skills"
CLAUDE_SKILLS="$HOME/.claude/skills"
AGENTS_SKILLS="$HOME/.agents/skills"

FORCE=0
SUBDIR=""
CLEANUP_ROOT="$(mktemp -d -t skills-add.XXXXXX)"
trap 'rm -rf "$CLEANUP_ROOT"' EXIT

log() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
usage:
  skills-add <owner>/<repo>                      install/update all skills from repo
  skills-add <owner>/<repo> <skill>              install/update one skill
  skills-add --subdir <path> <owner>/<repo>      scan <path>/skills/*/SKILL.md
                                                 (for plugin monorepos)
  skills-add --list                              print vendored skills
  skills-add --remove <name>                     remove a vendored skill
  skills-add --force <owner>/<repo> [<skill>]    overwrite local edits on update

flags are composable before the repo spec: --force and --subdir both accepted.
USAGE
  exit 1
}

# ---- helpers ----

lowercase() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

get_source_field() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  grep "^${key}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2-
}

# Deterministic hash of a skill tree, excluding the .source sidecar.
# Used to detect local edits on re-install.
content_hash() {
  local dir="$1"
  [ -d "$dir" ] || { printf ''; return; }
  (
    cd "$dir"
    find . -type f ! -name .source | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s\n' "$f"
      cat "$f"
    done
  ) | shasum -a 256 | cut -d' ' -f1
}

clone_upstream() {
  local repo="$1"
  local dir="$CLEANUP_ROOT/clone"
  rm -rf "$dir"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "$repo" "$dir" -- --depth=1 --quiet >/dev/null 2>&1 \
      || die "gh repo clone $repo failed"
  else
    git clone --depth=1 --quiet "https://github.com/$repo" "$dir" \
      || die "git clone https://github.com/$repo failed"
  fi
  git -C "$dir" rev-parse HEAD
}

# Emit one "<name><TAB><dir>" line per skill found upstream.
# If subdir is set, scans only <tmp>/<subdir>/skills/*/SKILL.md (plugin-monorepo layout).
# Else falls back through: skills/*/SKILL.md, */SKILL.md, ./SKILL.md.
scan_layout() {
  local tmp="$1" repo="$2" subdir="$3" found=0 md dir name
  local results

  if [ -n "$subdir" ]; then
    local root="$tmp/$subdir"
    [ -d "$root" ] || die "subdir not found in upstream: $subdir"

    # Prefer <subdir>/skills/*/SKILL.md (plugin monorepo layout)
    if [ -d "$root/skills" ]; then
      results="$(find "$root/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null || true)"
      if [ -n "$results" ]; then
        while IFS= read -r md; do
          [ -n "$md" ] || continue
          dir="$(dirname "$md")"
          name="$(basename "$dir")"
          printf '%s\t%s\n' "$name" "$dir"
          found=1
        done <<EOF
$results
EOF
      fi
    fi

    # Fall back to <subdir>/*/SKILL.md (flat layout under subdir)
    if [ "$found" -eq 0 ]; then
      results="$(find "$root" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null || true)"
      if [ -n "$results" ]; then
        while IFS= read -r md; do
          [ -n "$md" ] || continue
          dir="$(dirname "$md")"
          name="$(basename "$dir")"
          case "$name" in .*) continue ;; esac
          printf '%s\t%s\n' "$name" "$dir"
          found=1
        done <<EOF
$results
EOF
      fi
    fi

    if [ "$found" -eq 0 ]; then
      die "no SKILL.md found under $root (tried skills/*/ and */)"
    fi
    return 0
  fi

  if [ -d "$tmp/skills" ]; then
    results="$(find "$tmp/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null || true)"
    if [ -n "$results" ]; then
      while IFS= read -r md; do
        [ -n "$md" ] || continue
        dir="$(dirname "$md")"
        name="$(basename "$dir")"
        printf '%s\t%s\n' "$name" "$dir"
        found=1
      done <<EOF
$results
EOF
    fi
  fi

  if [ "$found" -eq 0 ]; then
    results="$(find "$tmp" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null || true)"
    if [ -n "$results" ]; then
      while IFS= read -r md; do
        [ -n "$md" ] || continue
        dir="$(dirname "$md")"
        name="$(basename "$dir")"
        case "$name" in .*) continue ;; esac
        printf '%s\t%s\n' "$name" "$dir"
        found=1
      done <<EOF
$results
EOF
    fi
  fi

  if [ "$found" -eq 0 ] && [ -f "$tmp/SKILL.md" ]; then
    name="${repo##*/}"
    printf '%s\t%s\n' "$name" "$tmp"
    found=1
  fi

  if [ "$found" -eq 0 ]; then
    die "no SKILL.md found in upstream (scanned: skills/*/SKILL.md, */SKILL.md, ./SKILL.md). Try --subdir <path> for plugin-monorepo layouts."
  fi
}

ensure_symlinks() {
  local name="$1"
  local target="$SKILLS_DIR/$name"
  mkdir -p "$CLAUDE_SKILLS" "$AGENTS_SKILLS"
  local link
  for link in "$CLAUDE_SKILLS/$name" "$AGENTS_SKILLS/$name"; do
    if [ -e "$link" ] && [ ! -L "$link" ]; then
      die "refuses to replace real path: $link"
    fi
    ln -sfn "$target" "$link"
  done
}

install_skill() {
  local repo="$1" sha="$2" name="$3" src_dir="$4" narrow="$5" subdir="$6"
  local target="$SKILLS_DIR/$name"
  local source_file="$target/.source"

  if [ -e "$target" ] && [ ! -f "$source_file" ]; then
    die "refuses to clobber $target (exists without .source — not vendored by skills-add)"
  fi

  if [ -f "$source_file" ]; then
    local prev_repo prev_hash prev_subdir
    prev_repo="$(get_source_field "$source_file" repo)"
    prev_hash="$(get_source_field "$source_file" hash)"
    prev_subdir="$(get_source_field "$source_file" subdir)"
    if [ "$prev_repo" != "$repo" ]; then
      die "upstream mismatch for $name: recorded $prev_repo, requested $repo"
    fi
    if [ "$prev_subdir" != "$subdir" ]; then
      die "subdir mismatch for $name: recorded '$prev_subdir', requested '$subdir'"
    fi
    if [ "$FORCE" -eq 0 ] && [ -n "$prev_hash" ]; then
      local current_hash
      current_hash="$(content_hash "$target")"
      if [ "$current_hash" != "$prev_hash" ]; then
        log "local edits detected in $target"
        log "  recorded hash: $prev_hash"
        log "  current hash:  $current_hash"
        die "re-run with --force to overwrite local edits"
      fi
    fi
  fi

  mkdir -p "$SKILLS_DIR"
  rm -rf "$target"
  mkdir -p "$target"

  # Copy src_dir contents into target, preserving dotfiles. tar pipe works on both GNU and BSD.
  (cd "$src_dir" && tar cf - .) | (cd "$target" && tar xf -)

  local new_hash
  new_hash="$(content_hash "$target")"

  {
    printf 'repo=%s\n' "$repo"
    if [ -n "$subdir" ]; then
      printf 'subdir=%s\n' "$subdir"
    fi
    printf 'commit=%s\n' "$sha"
    printf 'hash=%s\n' "$new_hash"
    if [ "$narrow" = "1" ]; then
      printf 'skill=%s\n' "$name"
    fi
  } > "$source_file"

  ensure_symlinks "$name"
  local suffix=""
  [ -n "$subdir" ] && suffix=" (subdir: $subdir)"
  log "installed: $name (from $repo @ ${sha:0:7})$suffix"
}

# ---- subcommands ----

cmd_list() {
  local any=0 src name
  for src in "$SKILLS_DIR"/*/.source; do
    [ -f "$src" ] || continue
    any=1
    name="$(basename "$(dirname "$src")")"
    printf '## %s\n' "$name"
    cat "$src"
    printf '\n'
  done
  if [ "$any" -eq 0 ]; then
    log 'no vendored skills'
  fi
}

cmd_remove() {
  local name="$1"
  local target="$SKILLS_DIR/$name"
  local src="$target/.source"
  [ -f "$src" ] || die "not vendored: $name (missing $src)"
  rm -rf "$target"
  local link
  for link in "$CLAUDE_SKILLS/$name" "$AGENTS_SKILLS/$name"; do
    if [ -L "$link" ]; then
      rm -f "$link"
    fi
  done
  log "removed: $name"
}

# ---- main ----

[ "$#" -gt 0 ] || usage

# Parse flags (composable, any order) until we hit the positional repo spec.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage ;;
    --list)    cmd_list; exit 0 ;;
    --remove)
      [ "$#" -ge 2 ] || die "--remove requires <name>"
      cmd_remove "$2"
      exit 0
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --subdir)
      [ "$#" -ge 2 ] || die "--subdir requires <path>"
      SUBDIR="$2"
      shift 2
      ;;
    --subdir=*)
      SUBDIR="${1#--subdir=}"
      shift
      ;;
    --) shift; break ;;
    -*) die "unknown flag: $1" ;;
    *)  break ;;
  esac
done

[ "$#" -ge 1 ] || usage

REPO="$1"
case "$REPO" in
  [A-Za-z0-9_.-]*/[A-Za-z0-9_.-]*) ;;
  *) die "repo must be <owner>/<repo>, got: $REPO" ;;
esac

NARROW_ARG="${2:-}"

SHA="$(clone_upstream "$REPO")"
TMP="$CLEANUP_ROOT/clone"

SCAN_OUTPUT="$(scan_layout "$TMP" "$REPO" "$SUBDIR")"

NARROW=0
NARROW_LC=""
if [ -n "$NARROW_ARG" ]; then
  NARROW_LC="$(lowercase "$NARROW_ARG")"
  NARROW=1
fi

# Plan install list with lowercasing + intra-batch collision check + narrow filter.
SEEN=""
PLAN=""
while IFS=$'\t' read -r raw_name src_dir; do
  [ -n "$raw_name" ] || continue
  lname="$(lowercase "$raw_name")"
  case " $SEEN " in
    *" $lname "*) die "skill name collision after lowercasing: $raw_name" ;;
  esac
  SEEN="$SEEN $lname"
  if [ "$NARROW" -eq 1 ] && [ "$lname" != "$NARROW_LC" ]; then
    continue
  fi
  PLAN="${PLAN}${lname}	${src_dir}
"
done <<EOF
$SCAN_OUTPUT
EOF

if [ "$NARROW" -eq 1 ] && [ -z "$PLAN" ]; then
  die "skill not found in upstream: $NARROW_ARG"
fi

# Install. Loop in current shell (not a pipe) so `die` exits the whole script.
while IFS=$'\t' read -r name dir; do
  [ -n "$name" ] || continue
  install_skill "$REPO" "$SHA" "$name" "$dir" "$NARROW" "$SUBDIR"
done <<EOF
$PLAN
EOF
