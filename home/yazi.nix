{...}: {
  programs.yazi = {
    enable = true;
    settings.manager.show_hidden = true;
    theme = {
      mode = {
        normal_main = {
          bg = "magenta";
          fg = "0";
          bold = true;
        };
        normal_alt = {
          bg = "magenta";
          fg = "0";
        };
      };
    };
  };
}
