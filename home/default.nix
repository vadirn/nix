{
  username,
  homeDirectory,
  vault-query,
  md-for-agents,
  hooky,
  hooky-console,
  hookyWiring,
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
        inherit username;
        stateVersion = "24.11";
        packages =
          (with pkgs; [
            ripgrep
            fd
            pass
            jq
            tree
            btop
            delta
            ngrok
            ruby
            ast-grep
            # Rust toolchain, from nixpkgs rather than rustup. Store paths are
            # immutable and the generation roots them, so these cannot dangle
            # the way the Homebrew rustup shims did: `~/.cargo/bin/*` were
            # static symlinks into a versioned Cellar path that
            # `homebrew.onActivation.cleanup = "zap"` deleted on every upgrade.
            # This is also the compiler `rustPlatform.buildRustPackage` uses in
            # flake.nix, so `cargo test` and `nix build` now agree by
            # construction instead of by coincidence.
            cargo
            rustc
            clippy
            rustfmt
          ])
          ++ [
            vault-query
            md-for-agents
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
          defaultCommand = "rg --files --hidden --glob '!.git'";
        };
        direnv = {
          enable = true;
          enableZshIntegration = true;
          nix-direnv = {
            enable = true;
            # nixos-26.05 ships 3.1.2, whose use_nix never watches shell.nix:
            # it passes the word `files_to_watch` to watch_file, not the array.
            # 3.2.0 fixes it (nix-community/nix-direnv#747). Drop this once
            # the nixpkgs pin reaches 3.2.0.
            package = let
              version = "3.2.0";
            in
              pkgs.nix-direnv.overrideAttrs (prev: {
                inherit version;
                # resholve builds in two layers: the outer one resolves the
                # inner one, which holds the source. So the source goes inside.
                src = prev.src.overrideAttrs {
                  inherit version;
                  src = pkgs.fetchFromGitHub {
                    owner = "nix-community";
                    repo = "nix-direnv";
                    rev = version;
                    hash = "sha256-dNJeSRuuqA2avtLpTse7mTTmnYdVnC5BxRsofuLXiqE=";
                  };
                };
              });
          };
        };
        zoxide = {
          enable = true;
          enableZshIntegration = false;
        };
        eza = {
          enable = true;
          enableZshIntegration = true;
        };
      };
      home.file.".bunfig.toml".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/bun/bunfig.toml";
      # Global oxfmt config. oxfmt's own discovery walks up from the cwd and
      # stops at a .git boundary, so it never finds this file from inside a
      # repo — autoformat compensates by passing it via -c when no
      # .oxfmtrc.json exists between the file and its repo root.
      # proseWrap: never collapses each markdown paragraph onto a single line.
      home.file.".oxfmtrc.json".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/bun/oxfmtrc.json";

      # The formatter CLI that resolves that config. Runs under bun via its own
      # shebang — oxfmt is itself a bun global (home/bun/install-globals.sh),
      # so the router adds no dependency its formatter does not already have.
      # Symlinked out of the store like the scripts in home/claude.nix, so
      # edits take effect without a rebuild. Claude Code reaches it through the
      # same PATH the terminal uses; hooks/hint-autoformat.sh only names it.
      # It sits in the home/agents/skills bun workspace to inherit that
      # workspace's pinned typecheck, lint, and test, and stays a single file
      # with no dependencies so this symlink can point straight at the source —
      # no install step, and no node_modules for the CLI to start.
      home.file.".local/bin/autoformat".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/agents/skills/tools/autoformat/autoformat.ts";

      # The hook router for Claude Code and Codex, on PATH as `hooky`. Both
      # harnesses' settings call it by its full path, since a harness may not
      # see this PATH. Its handler lists are linked in home/claude.nix and
      # home/codex.nix.
      home.file.".local/bin/hooky".source = "${hooky}/bin/hooky";
      # hooky was called route, and kept its logs and handler switches in
      # ~/.local/state/route. Move them once, before the hooky link exists, so
      # no hook event can create an empty state folder first.
      home.activation.moveRouteState = config.lib.dag.entryBetween ["linkGeneration"] ["writeBoundary"] ''
        old="$HOME/.local/state/route" new="$HOME/.local/state/hooky"
        if [[ -d "$old" && ! -e "$new" ]]; then
          run mv "$old" "$new"
        elif [[ -d "$old" ]]; then
          echo "Left $old in place: $new already exists." >&2
        fi
      '';
      # A harness's settings must wire only what hooky generates from its
      # handler list; a drifted settings file fails the switch here, and the
      # same checks run in CI before a merge (hooky-wiring.nix).
      home.checks = builtins.attrValues hookyWiring;

      # Hooky Console's build, linked so the generation roots it (rebuild.sh
      # collects garbage) and rebuild.sh signs and installs it from here.
      home.file.".local/share/hooky-console".source = hooky-console;

      imports = [
        ./zsh.nix
        ./tmux.nix
        ./git.nix
        ./starship.nix
        ./yazi.nix
        ./nvim/nvim.nix
        ./bat.nix
        ./claude.nix
        ./codex.nix
        ./opencode.nix
        ./ghostty.nix
        ./lazygit.nix
        ./micro.nix
      ];
    };
  };
}
