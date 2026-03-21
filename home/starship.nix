{...}: {
  programs.starship = {
    enable = true;
    enableZshIntegration = true;
    settings = {
      format = "\${env_var.ZMX_SESSION}$directory$git_branch$git_status$line_break$character";
      env_var.ZMX_SESSION = {
        format = "[$env_value]($style) ";
        style = "bold blue";
        default = "";
      };
      directory = {
        truncation_length = 3;
        truncate_to_repo = true;
      };
      git_branch = {
        format = "[$branch]($style)";
        style = "purple";
      };
      git_status = {
        format = "[[(*$conflicted$untracked$modified$staged$renamed$deleted)](218) ($ahead_behind$stashed)]($style)";
        style = "cyan";
        ahead = "+$count";
        diverged = "+$ahead_count/-$behind_count";
        behind = "-$count";
        conflicted = "​";
        untracked = "​";
        modified = "​";
        staged = "​";
        renamed = "​";
        deleted = "​";
        stashed = "≡";
      };
    };
  };
}
