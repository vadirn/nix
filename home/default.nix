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
          enableZshIntegration = false;
        };
        bat.enable = true;
      };
      home.activation.installClaude = config.lib.dag.entryAfter ["writeBoundary"] ''
        export PATH="${pkgs.curl}/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

        if [[ ! -x "$HOME/.local/bin/claude" ]]; then
          echo "Installing Claude Code..."
          curl -fsSL https://claude.ai/install.sh | bash
        fi
      '';

      home.file.".agents/scripts/ghostty-claude-split.applescript".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/scripts/ghostty-claude-split.applescript";
      home.file.".codex/AGENTS.md".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/AGENTS.md";
      home.file.".local/bin/skills-add".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/scripts/skills-add.sh";
      home.file.".local/bin/build-claude-md".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/build-claude-md.sh";
      home.file.".local/bin/sync-agents".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/scripts/sync-agents.sh";
      home.file.".claude/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/settings.json";
      home.file.".claude/hooks".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/hooks";
      home.file.".claude/agents".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/agents";
      home.file.".claude/statusline.sh".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/claude/statusline.sh";

      home.activation.buildClaudeMd = config.lib.dag.entryAfter ["writeBoundary"] ''
        ROOT="${homeDirectory}/nix" bash "${homeDirectory}/nix/home/claude/build-claude-md.sh"
      '';
      home.file.".config/git/hooks/post-commit".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/git/hooks/post-commit";
      home.file.".config/ghostty/config".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/ghostty-config";
      home.file.".config/lazygit/config.yml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/lazygit-config.yml";
      home.file.".config/lazygit/light.yml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/lazygit-light.yml";
      home.file.".config/micro/settings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/micro-settings.json";
      home.file.".config/micro/bindings.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/micro-bindings.json";
      programs.bat = {
        config.theme = "Catppuccin Mocha";
        themes = {
          "Catppuccin Latte" = {
            src = pkgs.fetchFromGitHub {
              owner = "catppuccin";
              repo = "bat";
              rev = "6810349b28055dce54076712fc05fc68da4b8ec0";
              hash = "sha256-lJapSgRVENTrbmpVyn+UQabC9fpV1G1e+CdlJ090uvg=";
            };
            file = "themes/Catppuccin Latte.tmTheme";
          };
          "Catppuccin Mocha" = {
            src = pkgs.fetchFromGitHub {
              owner = "catppuccin";
              repo = "bat";
              rev = "6810349b28055dce54076712fc05fc68da4b8ec0";
              hash = "sha256-lJapSgRVENTrbmpVyn+UQabC9fpV1G1e+CdlJ090uvg=";
            };
            file = "themes/Catppuccin Mocha.tmTheme";
          };
        };
      };

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
