{...}: {
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    sessionVariables = {
      LANG = "en_US.UTF-8";
      LC_ALL = "en_US.UTF-8";
      GPG_TTY = "$(tty)";

      NPM_CONFIG_PREFIX = "$HOME/.npm-global";
      EDITOR = "code --wait";
      DOCKER_HOST = "unix://$HOME/.orbstack/run/docker.sock";
    };

    localVariables = {
      ZSH_AUTOSUGGEST_STRATEGY = ["history" "completion"];
      ZSH_THEME_TERM_TAB_TITLE_IDLE = "%1~";
    };

    oh-my-zsh = {
      enable = true;
      plugins = [
        "git"
        "tmux"
      ];
    };

    initContent = ''
      ssh-add --apple-use-keychain ~/.ssh/github 2> /dev/null
      ssh-add --apple-use-keychain ~/.ssh/bitbucket 2> /dev/null
      ssh-add --apple-use-keychain ~/.ssh/vultr 2> /dev/null

      eval $(brew shellenv)

      if [ -z "$CLAUDECODE" ]; then
        eval "$(zoxide init --cmd cd zsh)"
      fi

      export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

      tc() {
        local name=''${PWD##*/}
        name=''${name//./-}
        if tmux has-session -t "$name" 2>/dev/null; then
          if [ -n "$TMUX" ]; then
            tmux switch-client -t "$name"
          else
            tmux attach-session -t "$name"
          fi
        else
          local cmd="claude --continue; read '?Kill tmux session? [Y/n] ' r; [[ \$r != [nN] ]] && tmux kill-session || exec \$SHELL"
          if [ -n "$TMUX" ]; then
            tmux new-session -d -s "$name" "$cmd" && tmux switch-client -t "$name"
          else
            tmux new-session -d -s "$name" "$cmd" && tmux attach-session -t "$name"
          fi
        fi
      }
    '';
  };
}
