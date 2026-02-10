{...}: {
  programs.yazi = {
    enable = true;
    theme = {
      mode = {
        normal_main = {bg = "blue"; fg = "white"; bold = true;};
        normal_alt = {bg = "blue"; fg = "white";};
      };
    };
  };
}
