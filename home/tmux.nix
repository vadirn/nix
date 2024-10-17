{pkgs, ...}: {
  programs.tmux = {
    enable = true;
    clock24 = true;
    mouse = true;

    plugins = with pkgs.tmuxPlugins; [
      tpm
      sensible
      yank
    ];

    extraConfig = ''
      bind | split-window -h
      bind _ split-window -v
    '';
  };
}
