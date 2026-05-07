{pkgs, ...}: {
  programs.git = {
    enable = true;
    lfs.enable = true;
    settings = {
      user.name = "Vadim Kotov";
      user.email = "vadim@vadirn.io";
      core.editor = "nvim";
      core.hooksPath = "~/.config/git/hooks";
      init.defaultBranch = "main";
      pull.ff = "only";
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
      { path = "~/nix/home/catppuccin-delta.gitconfig"; }
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
}
