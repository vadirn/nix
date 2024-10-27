{...}: {
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    sessionVariables = {
      LANG = "en_US.UTF-8";
      LC_ALL = "en_US.UTF-8";
      GPG_TTY = "(tty)";
    };

    localVariables = {
      ZSH_AUTOSUGGEST_STRATEGY = ["history" "completion"];
    };

    oh-my-zsh = {
      enable = true;
      theme = "robbyrussell";
      plugins = [
        "fzf"
        "git"
        "tmux"
      ];
    };

    initExtra = ''
      ssh-add ~/.ssh/github 2> /dev/null
      ssh-add ~/.ssh/bitbucket 2> /dev/null
      ssh-add ~/.ssh/vultr 2> /dev/null

      eval $(brew shellenv)
    '';
  };
}
