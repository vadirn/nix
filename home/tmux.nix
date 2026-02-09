{pkgs, ...}: {
  programs.tmux = {
    enable = true;
    clock24 = true;
    baseIndex = 1;
    mouse = true;

    plugins = with pkgs.tmuxPlugins; [
      yank
      {
        plugin = catppuccin;
        extraConfig = ''
          set -g @catppuccin_flavor "latte"
          set -g @catppuccin_window_status_style "rounded"
          set -g @catppuccin_session_icon "# "
          set -g @catppuccin_status_left_separator ""
          set -g @catppuccin_status_middle_separator ""
          set -g @catppuccin_status_right_separator "#[fg=#ccd0da,bg=#e6e9ef]#[none]"
        '';
      }
    ];

    extraConfig = ''
      set -g status-right-length 100
      set -g status-left " "
      set -g status-right "#{E:@catppuccin_status_session} "

      # dim inactive panes to match ghostty unfocused-split-opacity
      set -g window-style dim
      set -g window-active-style default

      bind | split-window -h
      bind _ split-window -v
      bind -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"

      set -g default-command "reattach-to-user-namespace -l $SHELL"
    '';
  };
}
