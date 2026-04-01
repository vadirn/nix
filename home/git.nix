{pkgs, ...}: {
  programs.git = {
    enable = true;
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
      merge.conflictstyle = "diff3";
      diff.colorMoved = "default";
      rebase.updateRefs = true;
      rebase.autosquash = true;
      rerere.enabled = true;
      core.hooksPath = "~/.config/git/hooks";
      gpg.format = "ssh";
      commit.gpgsign = true;
      tag.gpgsign = true;
    };
  };
}
