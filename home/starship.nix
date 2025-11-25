{...}: {
  programs.starship = {
    enable = true;
    enableZshIntegration = true;
    settings = {
      add_newline = false;
      format = "$directory$git_branch$git_status$nix_shell$nodejs$character";
      directory = {
        truncation_length = 3;
        truncate_to_repo = true;
      };
      git_branch = {
        format = "[$branch]($style) ";
        style = "bold purple";
      };
      git_status = {
        format = "[$all_status$ahead_behind]($style) ";
        style = "bold red";
      };
      nix_shell = {
        format = "[$symbol]($style) ";
        symbol = "nix";
        style = "bold blue";
      };
      nodejs = {
        format = "[$symbol($version)]($style) ";
        symbol = "node ";
        style = "bold green";
      };
      character = {
        success_symbol = "[➜](bold green)";
        error_symbol = "[➜](bold red)";
      };
    };
  };
}
