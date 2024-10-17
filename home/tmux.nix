{pkgs, ...}: {
  programs.tmux = {
    enable = true;
    clock24 = true;
    baseIndex = 1;
    terminal = "xterm-256color";
    mouse = true;

    plugins = with pkgs.tmuxPlugins; [
      sensible
      yank
    ];

    extraConfig = ''
      bind | split-window -h
      bind _ split-window -v
    '';
  };
}
