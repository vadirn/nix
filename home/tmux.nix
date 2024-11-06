{pkgs, ...}: {
  programs.tmux = {
    enable = true;
    clock24 = true;
    baseIndex = 1;
    mouse = true;

    plugins = with pkgs.tmuxPlugins; [
      yank
      catppuccin
    ];

    extraConfig = ''
      bind | split-window -h
      bind _ split-window -v

      set -g @catpuccin_flavor "latte"
      set -g status-left ""
      set -g status-right '#[fg=white]#[bold]%H:%M'
      set -g default-command "reattach-to-user-namespace -l $SHELL"
    '';
  };
}
