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
  skills-add --update                            refresh all vendored skills from upstream
  skills-add --update <name>                     refresh one vendored skill
  skills-add --list                              print vendored skills
  skills-add --remove <name>                     remove a vendored skill
  skills-add --diff                              regenerate .diff patch for all vendored skills
  skills-add --diff <name>                       regenerate .diff patch for one vendored skill
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
  grep "^${key}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# Deterministic hash of a skill tree, excluding the .source sidecar.
# Used to detect local edits on re-install.
content_hash() {
  local dir="$1"
  [ -d "$dir" ] || { printf ''; return; }
  (
    cd "$dir"
    find . -type f ! -name '.*' | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s\n' "$f"
      cat "$f"
    done
  ) | shasum -a 256 | cut -d' ' -f1
}

clone_upstream() {
  local repo="$1" want_sha="${2:-}"
  local dir="$CLEANUP_ROOT/clone"
  rm -rf "$dir"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "$repo" "$dir" -- --depth=1 --quiet >/dev/null 2>&1 \
      || die "gh repo clone $repo failed"
  else
    git clone --depth=1 --quiet "https://github.com/$repo" "$dir" \
      || die "git clone https://github.com/$repo failed"
  fi
  if [ -n "$want_sha" ]; then
    local got_sha
    got_sha="$(git -C "$dir" rev-parse HEAD)"
    if [ "$got_sha" != "$want_sha" ]; then
      git -C "$dir" fetch --quiet --depth=1 origin "$want_sha" 2>/dev/null \
        || die "git fetch $want_sha from $repo failed (SHA not fetchable — re-run skills-add to update the pinned commit)"
      git -C "$dir" checkout --quiet FETCH_HEAD
    fi
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

  if [ -e "$target" ] && [ ! -f "$source_file" ] && [ ! -f "$target/.diff" ]; then
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
  local stashed_diff=""
  if [ -f "$target/.diff" ]; then
    stashed_diff="$CLEANUP_ROOT/diff-$name"
    cp "$target/.diff" "$stashed_diff"
  fi
  rm -rf "$target"
  mkdir -p "$target"

  # Copy src_dir contents into target, preserving dotfiles. tar pipe works on both GNU and BSD.
  (cd "$src_dir" && tar cf - .) | (cd "$target" && tar xf -)

  if [ -n "$stashed_diff" ]; then
    cp "$stashed_diff" "$target/.diff"
    if ! patch -p1 -d "$target" --no-backup-if-mismatch <"$target/.diff" >"$CLEANUP_ROOT/apply-err" 2>&1; then
      log "patch failed for $name — upstream may have changed under the diff:"
      log "$(cat "$CLEANUP_ROOT/apply-err")"
      die "fix or remove $target/.diff and re-run"
    fi
  fi

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
  if [ -f "$target/.diff" ]; then
    log "warning: removing $name also drops $target/.diff — recover from git if uncommitted"
  fi
  rm -rf "$target"
  local link
  for link in "$CLAUDE_SKILLS/$name" "$AGENTS_SKILLS/$name"; do
    if [ -L "$link" ]; then
      rm -f "$link"
    fi
  done
  log "removed: $name"
}

cmd_update() {
  local target_name="${1:-}"
  local src_list=""

  if [ -n "$target_name" ]; then
    local src="$SKILLS_DIR/$target_name/.source"
    [ -f "$src" ] || die "not vendored: $target_name (missing $src)"
    src_list="$src"
  else
    local s
    for s in "$SKILLS_DIR"/*/.source; do
      [ -f "$s" ] || continue
      src_list="${src_list}${s}
"
    done
  fi

  if [ -z "$src_list" ]; then
    log 'no vendored skills to update'
    return 0
  fi

  # Dedup by (repo, subdir, skill) — broad installs from the same repo collapse to one invocation.
  local seen=""
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    local repo subdir skill key
    repo="$(get_source_field "$src" repo)"
    subdir="$(get_source_field "$src" subdir)"
    skill="$(get_source_field "$src" skill)"
    key="$repo|$subdir|$skill"
    case " $seen " in
      *" $key "*) continue ;;
    esac
    seen="$seen $key"

    local desc="$repo"
    [ -n "$subdir" ] && desc="$desc (subdir=$subdir)"
    [ -n "$skill" ] && desc="$desc [narrow: $skill]"
    log "--- updating: $desc ---"

    # Re-invoke self with the reconstructed args.
    local cmd="$SCRIPT_PATH"
    if [ "$FORCE" -eq 1 ]; then
      cmd="$cmd --force"
    fi
    if [ -n "$subdir" ]; then
      cmd="$cmd --subdir $subdir"
    fi
    cmd="$cmd $repo"
    if [ -n "$skill" ]; then
      cmd="$cmd $skill"
    fi
    # shellcheck disable=SC2086
    $cmd
  done <<EOF
$src_list
EOF
}

# diff_one_skill <name> <tmp_dir> <sha>
# Regenerates .diff for <name> against the upstream tree at <tmp_dir>
# (already cloned at <sha>), then recomputes hash= in .source.
diff_one_skill() {
  local name="$1" tmp="$2" sha="$3"
  local skill_dir="$SKILLS_DIR/$name"
  local source_file="$skill_dir/.source"
  [ -f "$source_file" ] || die "not vendored: $name (missing $source_file)"

  local repo subdir narrow_skill
  repo="$(get_source_field "$source_file" repo)"
  subdir="$(get_source_field "$source_file" subdir)"
  narrow_skill="$(get_source_field "$source_file" skill)"

  local scan_out upstream_dir
  scan_out="$(scan_layout "$tmp" "$repo" "$subdir")"

  # Find the upstream directory for this skill.
  # For narrow installs scan_layout may return multiple entries; match by name.
  upstream_dir=""
  while IFS=$'\t' read -r raw_name dir; do
    [ -n "$raw_name" ] || continue
    local lname
    lname="$(lowercase "$raw_name")"
    if [ -n "$narrow_skill" ]; then
      local lnarrow
      lnarrow="$(lowercase "$narrow_skill")"
      if [ "$lname" = "$lnarrow" ]; then
        upstream_dir="$dir"
        break
      fi
    else
      if [ "$lname" = "$name" ]; then
        upstream_dir="$dir"
        break
      fi
    fi
  done <<EOF
$scan_out
EOF

  if [ -z "$upstream_dir" ]; then
    die "could not locate $name in upstream $repo"
  fi

  local upstream_skill_md="$upstream_dir/SKILL.md"
  [ -f "$upstream_skill_md" ] || die "SKILL.md not found at $upstream_skill_md"

  local local_skill_md="$skill_dir/SKILL.md"
  [ -f "$local_skill_md" ] || die "local SKILL.md not found at $local_skill_md"

  local diff_out diff_file="$skill_dir/.diff"
  diff_out="$(diff -u --label a/SKILL.md --label b/SKILL.md "$upstream_skill_md" "$local_skill_md" || true)"

  if [ -z "$diff_out" ]; then
    # No difference between upstream and local.
    if [ -f "$diff_file" ]; then
      rm -f "$diff_file"
      log "diff: $name — removed stale .diff (local now matches upstream @ ${sha:0:7})"
    else
      log "diff: $name — no changes (upstream @ ${sha:0:7})"
    fi
  else
    # Write fresh .diff with git-style header.
    local had_diff=0
    [ -f "$diff_file" ] && had_diff=1
    { printf 'diff --git a/SKILL.md b/SKILL.md\n'; printf '%s\n' "$diff_out"; } > "$diff_file"
    if [ "$had_diff" -eq 1 ]; then
      log "diff: $name — updated .diff (upstream @ ${sha:0:7})"
    else
      log "diff: $name — wrote new .diff (upstream @ ${sha:0:7})"
    fi
  fi

  # Recompute hash after any .diff write/removal and update .source.
  local new_hash
  new_hash="$(content_hash "$skill_dir")"
  awk -v new_hash="$new_hash" '
    /^hash=/ { print "hash=" new_hash; next }
    { print }
  ' "$source_file" > "$source_file.tmp"
  mv "$source_file.tmp" "$source_file"
}

cmd_diff() {
  local target_name="${1:-}"

  if [ -n "$target_name" ]; then
    local src="$SKILLS_DIR/$target_name/.source"
    [ -f "$src" ] || die "not vendored: $target_name (missing $src)"
    local repo commit
    repo="$(get_source_field "$src" repo)"
    commit="$(get_source_field "$src" commit)"
    local sha
    sha="$(clone_upstream "$repo" "$commit")"
    diff_one_skill "$target_name" "$CLEANUP_ROOT/clone" "$sha"
    return 0
  fi

  # Batch mode: dedup clones by (repo, commit) pair.
  local any=0 src name
  # First pass: collect all (name, repo, commit) tuples.
  local skill_list=""
  for src in "$SKILLS_DIR"/*/.source; do
    [ -f "$src" ] || continue
    any=1
    name="$(basename "$(dirname "$src")")"
    local repo commit
    repo="$(get_source_field "$src" repo)"
    commit="$(get_source_field "$src" commit)"
    skill_list="${skill_list}${name}	${repo}	${commit}
"
  done

  if [ "$any" -eq 0 ]; then
    log 'no vendored skills'
    return 0
  fi

  # Second pass: clone once per (repo, commit), then process each skill.
  local seen_keys="" clone_idx=0
  while IFS=$'\t' read -r sname srepo scommit; do
    [ -n "$sname" ] || continue
    local key="${srepo}|${scommit}"
    local cache_dir="$CLEANUP_ROOT/diff-clone-${clone_idx}"

    # Check if we already have a clone for this (repo, commit).
    local cached_dir=""
    local k i=0
    while IFS=$'\t' read -r k d; do
      [ -n "$k" ] || continue
      if [ "$k" = "$key" ]; then
        cached_dir="$d"
        break
      fi
      i=$((i + 1))
    done <<EOF2
$seen_keys
EOF2

    if [ -z "$cached_dir" ]; then
      # New (repo, commit) pair — clone into a fresh directory.
      # clone_upstream always uses $CLEANUP_ROOT/clone; copy it out after cloning.
      local actual_sha
      actual_sha="$(clone_upstream "$srepo" "$scommit")"
      cp -r "$CLEANUP_ROOT/clone" "$cache_dir"
      seen_keys="${seen_keys}${key}	${cache_dir}	${actual_sha}
"
      clone_idx=$((clone_idx + 1))
      cached_dir="$cache_dir"
    fi

    # Retrieve the sha for this cache entry.
    local entry_sha=""
    while IFS=$'\t' read -r k d s; do
      [ -n "$k" ] || continue
      if [ "$k" = "$key" ]; then
        entry_sha="$s"
        break
      fi
    done <<EOF3
$seen_keys
EOF3

    diff_one_skill "$sname" "$cached_dir" "$entry_sha"
  done <<EOF
$skill_list
EOF
}

# ---- main ----

[ "$#" -gt 0 ] || usage

# Parse flags (composable, any order) until we hit the positional repo spec.
# Subcommands (--list, --remove, --update) are deferred so flags like --force
# can appear before OR after them.
SUBCMD=""
SUBCMD_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage ;;
    --list)
      [ -z "$SUBCMD" ] || die "conflicting subcommands: --$SUBCMD and --list"
      SUBCMD="list"
      shift
      ;;
    --remove)
      [ -z "$SUBCMD" ] || die "conflicting subcommands: --$SUBCMD and --remove"
      [ "$#" -ge 2 ] || die "--remove requires <name>"
      SUBCMD="remove"
      SUBCMD_ARG="$2"
      shift 2
      ;;
    --update)
      [ -z "$SUBCMD" ] || die "conflicting subcommands: --$SUBCMD and --update"
      SUBCMD="update"
      if [ "$#" -ge 2 ] && [ "${2#--}" = "$2" ]; then
        SUBCMD_ARG="$2"
        shift 2
      else
        shift
      fi
      ;;
    --diff)
      [ -z "$SUBCMD" ] || die "conflicting subcommands: --$SUBCMD and --diff"
      SUBCMD="diff"
      if [ "$#" -ge 2 ] && [ "${2#--}" = "$2" ]; then
        SUBCMD_ARG="$2"
        shift 2
      else
        shift
      fi
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

case "$SUBCMD" in
  list)   cmd_list; exit 0 ;;
  remove) cmd_remove "$SUBCMD_ARG"; exit 0 ;;
  update) cmd_update "$SUBCMD_ARG"; exit 0 ;;
  diff)   cmd_diff "$SUBCMD_ARG"; exit 0 ;;
esac

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
