{pkgs, ...}: {
  programs.tmux = {
    enable = true;
    clock24 = true;
    baseIndex = 1;
    mouse = true;

    plugins = with pkgs.tmuxPlugins; [
      yank
    ];

    extraConfig = ''
      # Message/command prompt
      set -g message-style "bg=default,fg=default"
      set -g message-command-style "bg=default,fg=default"

      # Status bar
      set -g status-style "bg=default,fg=default"
      set -g status-left " "
      set -g status-right-length 100
      set -g status-right "#[fg=green,bg=default]#[reverse]# #[noreverse,fg=colour0,bg=colour15] #S#[fg=colour15,bg=default] "

      # Window tabs (rounded)
      set -g window-status-format "#[fg=colour8,bg=default]#[reverse]#I #[noreverse,fg=colour0,bg=colour15] #W#[fg=colour15,bg=default]"
      set -g window-status-current-format "#[fg=magenta,bg=default]#[reverse]#I #[noreverse,fg=colour0,bg=colour15] #W#[fg=colour15,bg=default]"
      set -g window-status-separator " "

      bind | split-window -h
      bind _ split-window -v
      bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"

      set -g default-command "reattach-to-user-namespace -l $SHELL"
    '';
  };
}
