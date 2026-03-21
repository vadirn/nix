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
      RUSTUP_HOME = "$HOME/.rustup";
      CARGO_HOME = "$HOME/.cargo";
      XDG_CONFIG_HOME = "$HOME/.config";
      EDITOR = "code --wait";
      DOCKER_HOST = "unix://$HOME/.orbstack/run/docker.sock";
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

      export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

      _set_tab_title() { print -Pn "\e]0;%1~\a" }
      precmd_functions+=(_set_tab_title)
      chpwd_functions+=(_set_tab_title)

      lg() {
        local cfg="$HOME/.config/lazygit/config.yml"
        if [[ "$(defaults read -g AppleInterfaceStyle 2>/dev/null)" != "Dark" ]]; then
          cfg="$cfg,$HOME/.config/lazygit/light.yml"
        fi
        LG_CONFIG_FILE="$cfg" lazygit "$@"
      }
      alias y='yazi'

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

      cl() { claude --continue || claude; }
      cln() { claude; }
    '';
  };
}
