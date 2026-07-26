{
  username,
  homeDirectory,
  vault-query,
  mdread,
  mdstruct,
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
          ])
          ++ [
            vault-query
            mdread
            mdstruct
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
      home.file.".local/bin/autoformat".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/scripts/autoformat.ts";

      imports = [
        ./zsh.nix
        ./tmux.nix
        ./git.nix
        ./starship.nix
        ./yazi.nix
        ./nvim/nvim.nix
        ./bat.nix
        ./claude.nix
        ./ghostty.nix
        ./lazygit.nix
        ./micro.nix
      ];
    };
  };
}
