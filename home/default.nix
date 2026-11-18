{
  username,
  homeDirectory,
  vault-query,
  md-for-agents,
  route,
  route-console,
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

      # The Claude Code hook router, linked off PATH: macOS ships /sbin/route,
      # and settings.json calls this one by its full path anyway. Its handler
      # list is linked in home/claude.nix.
      home.file.".local/libexec/route".source = "${route}/bin/route";
      # Every hook in settings.json goes through route: its hooks block must be
      # what route generates from hooks.json (README, route). A hook wired
      # into settings.json directly, or a hooks.json change not applied there,
      # fails the switch here.
      home.checks = [
        (pkgs.runCommand "route-wiring" {nativeBuildInputs = [pkgs.jq];} ''
          ${route}/bin/route --config ${./claude/route/hooks.json} settings \
            --bin "~/.local/libexec/route" | jq -S .hooks > want
          jq -S .hooks ${./claude/settings.json} > have
          if ! diff -u want have >&2; then
            echo "home/claude/settings.json wires hooks that route does not generate from home/claude/route/hooks.json." >&2
            echo "Put the handler in hooks.json, then regenerate and apply the route entries (README, route)." >&2
            exit 1
          fi
          touch $out
        '')
      ];

      # Route Console's build, linked so the generation roots it (rebuild.sh
      # collects garbage) and rebuild.sh signs and installs it from here.
      home.file.".local/share/route-console".source = route-console;

      imports = [
        ./zsh.nix
        ./tmux.nix
        ./git.nix
        ./starship.nix
        ./yazi.nix
        ./nvim/nvim.nix
        ./bat.nix
        ./claude.nix
        ./opencode.nix
        ./ghostty.nix
        ./lazygit.nix
        ./micro.nix
      ];
    };
  };
}
