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

      export PATH="$HOME/.npm-global/bin:$PATH"
    '';
  };
}
