return {
  "folke/snacks.nvim",
  priority = 1000,
  lazy = false,
  opts = {
    picker = { enabled = true },
  },
  keys = {
    { "<leader><space>", function() Snacks.picker.files() end,    desc = "Find files" },
    { "<leader>/",       function() Snacks.picker.grep() end,     desc = "Grep" },
    { "<leader>,",       function() Snacks.picker.buffers() end,  desc = "Buffers" },
    { "<leader>sk",      function() Snacks.picker.keymaps() end,  desc = "Search keymaps" },
    { "<leader>sh",      function() Snacks.picker.help() end,     desc = "Help pages" },
    { "<leader>sr",      function() Snacks.picker.recent() end,   desc = "Recent files" },
  },
}
