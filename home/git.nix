{pkgs, ...}: {
  programs.git = {
    enable = true;
    lfs.enable = true;
    userName = "Vadim Kotov";
    userEmail = "vadim@vadirn.io";
    delta = {
      enable = true;
      options = {
        navigate = true;
        line-numbers = true;
        features = "catppuccin-mocha";
      };
    };
    includes = [
      { path = "~/nix/home/catppuccin-delta.gitconfig"; }
    ];
    extraConfig = {
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
  };
}
