{...}: {
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    sessionVariables = {
      LANG = "en_US.UTF-8";
      LC_ALL = "en_US.UTF-8";
      NPM_CONFIG_PREFIX = "$HOME/.npm-global";
      RUSTUP_HOME = "$HOME/.rustup";
      CARGO_HOME = "$HOME/.cargo";
      XDG_CONFIG_HOME = "$HOME/.config";
      EDITOR = "code --wait";
      DOCKER_HOST = "unix://$HOME/.orbstack/run/docker.sock";
      AGENT_BROWSER_AUTO_CONNECT = "1";
    };

    localVariables = {
      ZSH_AUTOSUGGEST_STRATEGY = ["history" "completion"];
      DISABLE_AUTO_TITLE = "true";
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

      export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

      _set_tab_title() { print -Pn "\e]0;%1~\a" }
      precmd_functions+=(_set_tab_title)
      chpwd_functions+=(_set_tab_title)

      lg() {
        local cfg="$HOME/.config/lazygit/config.yml"
        if [[ "$(defaults read -g AppleInterfaceStyle 2>/dev/null)" != "Dark" ]]; then
          cfg="$HOME/.config/lazygit/light.yml"
        fi
        export LAZYGIT_NEW_DIR_FILE=~/.lazygit/newdir
        LG_CONFIG_FILE="$cfg" command lazygit "$@"
        if [ -f $LAZYGIT_NEW_DIR_FILE ]; then
          cd "$(cat $LAZYGIT_NEW_DIR_FILE)"
          rm -f $LAZYGIT_NEW_DIR_FILE > /dev/null
        fi
      }
      alias y='yazi'
      alias v='nvim'

      alias gtimeout='timeout'

      tt() {
        local depth="''${1:-3}"
        shift 2>/dev/null
        local args=(--tree --group-directories-first -L "$depth" --ignore-glob .git --ignore-glob node_modules --ignore-glob .direnv)
        for p in "$@"; do
          args+=(--ignore-glob "$p")
        done
        eza "''${args[@]}" | less -FRNX
      }

      tmpclean() {
        local days="''${1:-7}"
        find /tmp/claude* -mtime +"$days" -type f -delete 2>/dev/null
      }

      cl() { claude --continue || claude; }
      cln() { claude; }
      clw() { claude --worktree "wt-$(date +%Y-%m-%d-%H-%M-%S)"; }

      fif() {
        local rg='rg --column --line-number --no-heading --color=always --smart-case'
        fzf --ansi --disabled --query "''${1:-}" \
            --bind "start:reload:''${rg} {q}" \
            --bind "change:reload:''${rg} {q}" \
            --delimiter : \
            --preview 'rg --pretty --context 3 -- {q} {1} 2>/dev/null || cat {1}' \
            --bind 'enter:become(nvim +{2} -- {1})'
      }

      git-cleanup() {
        echo '--- pruning stale remote-tracking refs ---'
        git remote prune origin
        echo '--- deleting local branches whose upstream is gone ---'
        git branch -vv | grep ': gone]' | grep -v '\*' | awk '{ print ''$1; }' | xargs -I B git branch -D "B"
        echo '--- garbage-collecting rerere cache ---'
        git rerere gc
      }
    '';
  };
}
