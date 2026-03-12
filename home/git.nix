{pkgs, ...}: {
  programs.git = {
    enable = true;
    delta = {
      enable = true;
      options = {
        navigate = true;
        line-numbers = true;
        syntax-theme = "GitHub";
      };
    };
    extraConfig = {
      merge.conflictstyle = "diff3";
      diff.colorMoved = "default";
      rebase.updateRefs = true;
      rebase.autosquash = true;
      rerere.enabled = true;
      core.hooksPath = "~/.config/git/hooks";
    };
  };
}
