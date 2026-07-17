{
  pkgs,
  config,
  ...
}: let
  homeDirectory = config.home.homeDirectory;
in {
  home.file.".claude/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/settings.json";
  home.file.".claude/hooks".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/hooks";
  home.file.".claude/agents".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/agents";
  home.file.".claude/output-styles".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/output-styles";
  home.file.".claude/statusline.sh".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/statusline.sh";
  home.file.".agents/scripts/ghostty-claude-split.applescript".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/scripts/ghostty-claude-split.applescript";
  home.file.".local/bin/skills-add".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/scripts/skills-add.sh";
  home.file.".local/bin/build-claude-md".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/build-claude-md.sh";
  home.file.".local/bin/sync-agents".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/scripts/sync-agents.sh";
  home.file.".local/bin/pr-template".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/scripts/pr-template.sh";
  home.file.".local/bin/distill-text".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/skills/textkit/bin/distill-text";
  home.file.".local/bin/polish-text".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/skills/textkit/bin/polish-text";
  home.file.".local/bin/card-stage".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/skills/textkit/bin/card-stage";

  # Claude Code is not packaged in nixpkgs; this activation intentionally
  # performs an impure network fetch to install the official binary.
  home.activation.installClaude = config.lib.dag.entryAfter ["writeBoundary"] ''
    export PATH="${pkgs.curl}/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

    if [[ ! -x "$HOME/.local/bin/claude" ]]; then
      echo "Installing Claude Code..."
      curl -fsSL https://claude.ai/install.sh | bash
    fi
  '';

  home.activation.buildClaudeMd = config.lib.dag.entryAfter ["writeBoundary"] ''
    ROOT="${homeDirectory}/nix" bash "${homeDirectory}/nix/home/claude/build-claude-md.sh"
  '';
}
