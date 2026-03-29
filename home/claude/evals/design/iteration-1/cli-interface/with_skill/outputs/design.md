# CLI Interface Design: File Sync Tool

## Design 1: Profile-Centric Approach

**Constraint:** Optimize for multi-profile management and quick profile switching.

### Interface Signature
```bash
syncfs [global-options] <command> [command-options] [args]

Global Options:
  --profile, -p <name>    Use specified profile
  --config-dir <path>     Custom config directory
  --verbose, -v           Enable verbose output

Commands:
  profile create <name> --local=<path> --remote=<s3-uri> [options]
  profile list
  profile delete <name>
  sync start [profile]    Start watching and syncing
  sync once [profile]     One-time sync
  sync status             Show sync status
  ignore add <pattern> [--profile=<name>]
  ignore remove <pattern> [--profile=<name>]
  ignore list [--profile=<name>]
```

### Usage Example
```bash
# Setup profiles
syncfs profile create work --local=~/work --remote=s3://company-bucket/work
syncfs profile create personal --local=~/docs --remote=s3://my-bucket/personal

# Configure ignore patterns
syncfs ignore add "*.tmp" --profile=work
syncfs ignore add ".DS_Store" --profile=work

# Start syncing
syncfs --profile=work sync start
syncfs --profile=personal sync once --dry-run
```

### Tradeoffs
- **Pros:** Clear profile management, easy switching between configurations
- **Cons:** More verbose for single-profile use cases, requires profile setup before first sync

## Design 2: Directory-First Approach

**Constraint:** Optimize for simplicity and immediate use without setup.

### Interface Signature
```bash
syncfs [options] <local-path> <s3-uri>

Options:
  --watch, -w             Enable continuous watching
  --dry-run, -n           Show what would be synced without doing it
  --ignore-file <path>    Path to ignore patterns file
  --ignore <pattern>      Add ignore pattern (repeatable)
  --config <file>         Save/load configuration from file
  --verbose, -v           Enable verbose output
  --one-time              Sync once and exit (default without --watch)
```

### Usage Example
```bash
# Quick one-time sync
syncfs ~/work s3://company-bucket/work --dry-run
syncfs ~/work s3://company-bucket/work

# Continuous watching
syncfs ~/work s3://company-bucket/work --watch --ignore="*.tmp" --ignore=".git/*"

# Save configuration for reuse
syncfs ~/work s3://company-bucket/work --watch --config=work.toml
syncfs --config=work.toml  # reuse saved config
```

### Tradeoffs
- **Pros:** Immediate use, simple mental model, no setup required
- **Cons:** Config reuse is more manual, harder to manage multiple sync targets

## Design 3: Workspace-Based Approach

**Constraint:** Optimize for project-based workflows and team collaboration.

### Interface Signature
```bash
syncfs [global-options] [workspace/]command [command-options]

Global Options:
  --workspace, -w <name>  Target workspace (default: current directory)
  --global, -g           Apply to global config

Commands:
  init <s3-uri>          Initialize workspace with S3 target
  add <path> [--ignore=<pattern>...]  Add path to sync with optional ignores
  remove <path>          Remove path from sync
  start                  Start continuous sync for workspace
  stop                   Stop sync daemon
  status                 Show sync status and configuration
  dry-run                Preview what would be synced
  ignore <pattern>       Add ignore pattern to workspace
  pull                   Force pull from S3
  push                   Force push to S3
```

### Usage Example
```bash
# Initialize project workspace
cd ~/projects/myapp
syncfs init s3://company-bucket/myapp
syncfs add src/ --ignore="*.log"
syncfs add config/
syncfs ignore "node_modules/*"

# Start syncing
syncfs start
syncfs status

# One-off operations
syncfs dry-run
syncfs pull  # force sync down from S3
```

### Tradeoffs
- **Pros:** Project-aware, team-friendly (workspace configs can be shared), context-aware
- **Cons:** More complex, requires workspace initialization, less portable across directories

## Comparison

| Aspect | Profile-Centric | Directory-First | Workspace-Based |
|--------|----------------|-----------------|-----------------|
| Setup complexity | Medium | Low | High |
| Multi-target use | Excellent | Poor | Excellent |
| Immediate use | Poor | Excellent | Poor |
| Team sharing | Good | Poor | Excellent |
| Mental overhead | Medium | Low | High |
| Configuration reuse | Excellent | Manual | Excellent |

## Synthesis and Recommendation

For a file sync tool targeting developers and teams, I recommend the **Workspace-Based Approach** with the following rationale:

1. **Project context matters:** Developers think in terms of projects/repositories. A workspace-based approach aligns with this mental model.

2. **Team collaboration:** Workspace configuration can be committed to version control, enabling consistent sync behavior across team members.

3. **Scaling:** As projects grow, the ability to selectively sync subdirectories and manage complex ignore patterns becomes crucial.

4. **Power user friendly:** While it has higher initial complexity, it provides the most powerful feature set for sustained use.

**Implementation priority:** Start with core workspace functionality, then add profile-like features for cross-workspace management in later versions.

The recommended CLI balances power-user needs with team collaboration while maintaining a logical project-based mental model that developers expect.
