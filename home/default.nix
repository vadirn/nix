{
  username,
  homeDirectory,
  ...
}: {
  users.users.vadim.home = homeDirectory;
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "beforeHomeManager";
    users.vadim = {
      pkgs,
      config,
      ...
    }: {
      home = {
        username = username;
        stateVersion = "24.11";
        packages = with pkgs; [
          ripgrep
          fd
          pass
          jq
          tree
          bat
          btop
          delta
          ngrok
          ruby
        ];
      };
      programs = {
        home-manager = {
          enable = true;
        };
        fzf = {
          enable = true;
          enableZshIntegration = true;
          enableBashIntegration = true;
        };
        direnv = {
          enable = true;
          enableZshIntegration = true;
          nix-direnv.enable = true;
        };
        zoxide = {
          enable = true;
          enableZshIntegration = false;
        };
        eza = {
          enable = true;
          enableZshIntegration = true;
        };
        lazygit = {
          enable = true;
          settings = {
            os.editPreset = "micro";
            gui.theme.selectedLineBgColor = [ "#A590FF" ];
          };
        };
      };
      home.activation.installClaude = config.lib.dag.entryAfter ["writeBoundary"] ''
        export PATH="${pkgs.curl}/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

        if [[ ! -x "$HOME/.local/bin/claude" ]]; then
          echo "Installing Claude Code..."
          curl -fsSL https://claude.ai/install.sh | bash
        fi
      '';

      home.activation.installBun = config.lib.dag.entryAfter ["writeBoundary"] ''
        if [[ ! -x "$HOME/.bun/bin/bun" ]]; then
          echo "Installing Bun..."
          export PATH="${pkgs.curl}/bin:${pkgs.unzip}/bin:$PATH"
          curl -fsSL https://bun.sh/install | bash
        fi
      '';

      home.file.".local/bin/session-stats".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/skills/session-stats/session-stats.py";
      home.file.".local/bin/tool-stats".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/skills/tool-stats/tool-stats.py";
      home.file.".local/bin/vault-cli".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/skills/vault/scripts/vault-cli";
      home.file.".claude/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/settings.json";
      home.file.".claude/CLAUDE.md".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/CLAUDE.md";
      home.file.".claude/skills".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/skills";
      home.file.".claude/hooks".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/hooks";
      home.file.".claude/statusline.sh".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/statusline.sh";
      home.file.".config/git/hooks/post-commit".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/git/hooks/post-commit";
      home.file.".config/ghostty/config".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/ghostty-config";
      home.file.".config/micro/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/micro-settings.json";
      home.file.".config/micro/bindings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/micro-bindings.json";
      imports = [
        ./zsh.nix
        ./tmux.nix
        ./git.nix
        ./starship.nix
        ./yazi.nix
      ];
    };
  };
}
