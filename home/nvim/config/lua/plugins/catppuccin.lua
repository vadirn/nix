return {
  "catppuccin/nvim",
  name = "catppuccin",
  priority = 1000,
  lazy = false,
  config = function()
    local function macos_is_dark()
      local handle = io.popen("defaults read -g AppleInterfaceStyle 2>/dev/null")
      if not handle then return false end
      local result = handle:read("*a") or ""
      handle:close()
      return result:match("Dark") ~= nil
    end

    local function sync_background()
      vim.opt.background = macos_is_dark() and "dark" or "light"
    end

    sync_background()

    require("catppuccin").setup({
      background = { light = "latte", dark = "mocha" },
    })
    vim.cmd.colorscheme("catppuccin")

    vim.api.nvim_create_autocmd("FocusGained", {
      callback = function()
        local prev = vim.o.background
        sync_background()
        if vim.o.background ~= prev then
          vim.cmd.colorscheme("catppuccin")
        end
      end,
    })
  end,
}
