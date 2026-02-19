{pkgs, ...}: {
  programs.yazi = {
    enable = true;
    plugins = {
      "no-status" = pkgs.yaziPlugins.no-status;
    };
    initLua = ''
      require("no-status"):setup()
    '';
    keymap.mgr.prepend_keymap = [
      {
        on = [":"];
        run = "shell --interactive";
      }
    ];
    settings.mgr.show_hidden = true;
    settings.opener.edit = [{
      run = ''micro "$@"'';
      block = true;
    }];
    theme = {
      mode = {
        normal_main = {
          bg = "magenta";
          fg = "0";
          bold = true;
        };
        normal_alt = {
          bg = "15";
          fg = "0";
        };
        select_main = {
          bg = "green";
          fg = "0";
          bold = true;
        };
        select_alt = {
          bg = "15";
          fg = "0";
        };
        unset_main = {
          bg = "8";
          fg = "0";
          bold = true;
        };
        unset_alt = {
          bg = "15";
          fg = "0";
        };
      };
      tabs = {
        active = {
          bg = "magenta";
          fg = "0";
          bold = true;
        };
        inactive = {
          bg = "8";
          fg = "15";
        };
      };
      status = {
        sep_left = {
          open = "";
          close = "";
        };
        sep_right = {
          open = "";
          close = "";
        };
      };
    };
  };
}
