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
      EDITOR = "zed --wait";
      DOCKER_HOST = "unix://$HOME/.orbstack/run/docker.sock";
      AGENT_BROWSER_AUTO_CONNECT = "1";
      USE_BUILTIN_RIPGREP = "0";
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

      export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"

      _set_tab_title() { print -Pn "\e]0;%1~\a" }
      precmd_functions+=(_set_tab_title)
      chpwd_functions+=(_set_tab_title)

      # True when macOS is in Dark mode. AppleInterfaceStyle is unset in Light
      # mode, so the read fails and the test is false.
      _macos_is_dark() {
        [[ "$(defaults read -g AppleInterfaceStyle 2>/dev/null)" == "Dark" ]]
      }

      lg() {
        local cfg="$HOME/.config/lazygit/config.yml"
        _macos_is_dark || cfg="$HOME/.config/lazygit/light.yml"
        export LAZYGIT_NEW_DIR_FILE=~/.lazygit/newdir
        LG_CONFIG_FILE="$cfg" command lazygit "$@"
        if [ -f $LAZYGIT_NEW_DIR_FILE ]; then
          cd "$(cat $LAZYGIT_NEW_DIR_FILE)"
          rm -f $LAZYGIT_NEW_DIR_FILE > /dev/null
        fi
      }

      # git worktree helpers (fzf-backed, no TUI). Create lives under
      # $WT_ROOT (default ~/Documents/worktrees/<repo>/<branch>).
      wt() {
        emulate -L zsh
        local dir=$(git worktree list 2>/dev/null | fzf --height 40% --reverse --prompt 'cd> ' | awk '{print $1}')
        [[ -n $dir ]] && cd "$dir"
      }

      wtp() {
        emulate -L zsh
        local dir=$(git worktree list 2>/dev/null | fzf --height 40% --reverse --prompt 'copy> ' | awk '{print $1}')
        [[ -n $dir ]] && printf %s "$dir" | pbcopy && print "copied: $dir"
      }

      wtc() {
        emulate -L zsh
        local branch=$1 base=''${2:-HEAD} top dir
        [[ -n $branch ]] || { print -u2 'usage: wtc <branch> [base-ref]'; return 1 }
        top=$(git rev-parse --show-toplevel 2>/dev/null) || { print -u2 'wtc: not in a git repo'; return 1 }
        dir=''${WT_ROOT:-$HOME/Documents/worktrees}/''${top:t}/$branch
        mkdir -p "''${dir:h}"
        if git show-ref --verify --quiet "refs/heads/$branch"; then
          git worktree add "$dir" "$branch" || return
        else
          git worktree add -b "$branch" "$dir" "$base" || return
        fi
        cd "$dir"
      }

      wtd() {
        emulate -L zsh
        local dir=$(git worktree list 2>/dev/null | fzf --height 40% --reverse --prompt 'remove> ' | awk '{print $1}')
        [[ -n $dir ]] || return
        git worktree remove "$dir" && print "removed: $dir"
      }

      alias y='yazi'
      alias v='nvim'

      # Terseness for the distill-text CLI lives here, not in the binary name:
      # distill-text stays greppable and self-describing on PATH.
      alias dn='distill-text'

      alias gtimeout='timeout'

      # Render markdown through oxfmt so prose wraps correctly. glamour (glow's
      # renderer) mis-breaks hyphenated words when it wraps; oxfmt reflows the
      # source at its print width, and `glow -w 0` prints that verbatim instead
      # of re-wrapping. The reflow is dry (stdin -> stdout), so source files stay
      # unwrapped on disk (oxfmtrc.json proseWrap:never). Non-markdown, TUI, and
      # multi-arg calls fall through to plain `glow -w 0`.
      glow() {
        emulate -L zsh
        local cfg="$HOME/nix/home/oxfmt-prose-wrap.json"
        if [[ $# -eq 1 && -f $1 && $1 == *.md && -r $cfg ]]; then
          local out
          if out=$(command oxfmt --stdin-filepath="$1" -c "$cfg" <"$1" 2>/dev/null) && [[ -n $out ]]; then
            print -r -- "$out" | command glow -w 0
            return
          fi
        fi
        command glow -w 0 "$@"
      }

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
