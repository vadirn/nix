{
  pkgs,
  config,
  ...
}: let
  homeDirectory = config.home.homeDirectory;
in {
  programs.git = {
    enable = true;
    lfs.enable = true;
    ignores = [
      "**/.claude/settings.local.json"
      "**/.vault.config.json"
      "**/.claude-plans/"
      "**/.firecrawl/"
      "**/.playwright-mcp/"
    ];
    settings = {
      user.name = "Vadim Kotov";
      user.email = "vadim@vadirn.io";
      core.editor = "nvim";
      core.hooksPath = "~/.config/git/hooks";
      init.defaultBranch = "main";
      pull.ff = "only";
      push.autoSetupRemote = true;
      merge.conflictstyle = "diff3";
      diff.colorMoved = "default";
      rebase.updateRefs = true;
      rebase.autosquash = true;
      rerere.enabled = true;
      gpg.format = "ssh";
      commit.gpgsign = true;
      tag.gpgsign = true;
    };
    includes = [
      {path = "~/nix/home/catppuccin-delta.gitconfig";}
    ];
  };
  programs.delta = {
    enable = true;
    enableGitIntegration = true;
    options = {
      navigate = true;
      line-numbers = true;
      features = "catppuccin-mocha";
    };
  };
  xdg.configFile."git/hooks/post-commit".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/git/hooks/post-commit";
  xdg.configFile."git/hooks/commit-msg".source = config.lib.file.mkOutOfStoreSymlink "${homeDirectory}/nix/home/git/hooks/commit-msg";
}
