-- You can add your own plugins here or in other files in this directory!
--  I promise not to create any merge conflicts in this directory :)
--
-- See the kickstart.nvim README for more information
return {
  { 'tpope/vim-abolish' },
  {
    'numToStr/Comment.nvim',
    opts = {
      -- add any options here
    },
  },
  {
    'folke/trouble.nvim', -- https://neovimcraft.com/plugin/folke/trouble.nvim/
    opts = {}, -- for default options, refer to the configuration section for custom setup.
    cmd = 'Trouble',
    keys = {
      {
        '<leader>xx',
        '<cmd>Trouble diagnostics toggle<cr>',
        desc = 'Diagnostics (Trouble)',
      },
      {
        '<leader>xX',
        '<cmd>Trouble diagnostics toggle filter.buf=0<cr>',
        desc = 'Buffer Diagnostics (Trouble)',
      },
      {
        '<leader>cs',
        '<cmd>Trouble symbols toggle focus=false<cr>',
        desc = 'Symbols (Trouble)',
      },
      {
        '<leader>cl',
        '<cmd>Trouble lsp toggle focus=false win.position=right<cr>',
        desc = 'LSP Definitions / references / ... (Trouble)',
      },
      {
        '<leader>xL',
        '<cmd>Trouble loclist toggle<cr>',
        desc = 'Location List (Trouble)',
      },
      {
        '<leader>xQ',
        '<cmd>Trouble qflist toggle<cr>',
        desc = 'Quickfix List (Trouble)',
      },
    },
  },
  {
    'stevearc/aerial.nvim',
    opts = {},
    -- Optional dependencies
    dependencies = {
      'nvim-treesitter/nvim-treesitter',
      'nvim-tree/nvim-web-devicons',
    },
  },
  {
    -- 'yetone/avante.nvim',
    -- Fork (remote): git@github.com:trogers1/avante-with-permissions.nvim.git
    'trogers1/avante-with-permissions.nvim',
    -- Fork (local):
    -- dir = vim.fn.expand('~/.config/avante-with-permissions.nvim'),
    -- name = 'avante.nvim',
    event = 'VeryLazy',
    version = false, -- Never set this value to "*"! Never!
    -- WARN: must add this setting! ! !
    build = vim.fn.has 'win32' ~= 0 and 'powershell -ExecutionPolicy Bypass -File Build.ps1 -BuildFromSource false' or 'make',
    ---@module 'avante'
    ---@type avante.Config
    opts = {
      -- add any opts here
      -- this file can contain specific instructions for your project
      instructions_file = 'AGENTS.md',
      provider = 'opencode',
      behaviour = {
        auto_suggestions = false,
        -- IMPORTANT: don't auto-approve ACP tool permissions
        auto_approve_tool_permissions = false,
      },
      -- Avante-native permissions (used for non-ACP providers)
      permission = {
        bash = {
          ['*'] = 'ask',
          ['git *'] = 'ask',
          -- git READ-only
          ['git status*'] = 'allow',
          ['git status *'] = 'allow',
          ['git log*'] = 'allow',
          ['git log *'] = 'allow',
          ['git rm *'] = 'allow',
          ['git mv *'] = 'allow',
          ['git diff'] = 'allow',
          ['git diff *'] = 'allow',
          ['git pull'] = 'allow',
          ['git grep *'] = 'allow',
          ['git bisect *'] = 'allow',
          ['git show *'] = 'allow',
          -- Git destructive
          ['git branch *'] = 'deny',
          ['git rebase *'] = 'deny',
          ['git switch *'] = 'deny',
          ['git tag *'] = 'deny',
          ['git commit *'] = 'deny',
          ['git push *'] = 'deny',
          ['git checkout *'] = 'deny',
          ['git add *'] = 'deny',
          ['git worktree *'] = 'deny',
          ['grep *'] = 'allow',
          ['npx vitest *'] = 'allow',
          ['sed *'] = 'allow',
          ['ls *'] = 'allow',
          ['npm *'] = 'allow',
          ['openspec *'] = 'allow',
        },
        external_directory = 'ask',
      },
      -- for example
      acp_providers = {
        ['opencode'] = {
          command = 'opencode',
          args = { 'acp' },
        },
      },
      -- I'm going through opencode for now, so no actual providers need set up
      -- providers = {
      --   claude = {
      --     endpoint = 'https://api.anthropic.com',
      --     model = 'claude-sonnet-4-20250514',
      --     timeout = 30000, -- Timeout in milliseconds
      --     extra_request_body = {
      --       temperature = 0.75,
      --       max_tokens = 20480,
      --     },
      --   },
      --   moonshot = {
      --     endpoint = 'https://api.moonshot.ai/v1',
      --     model = 'kimi-k2-0711-preview',
      --     timeout = 30000, -- Timeout in milliseconds
      --     extra_request_body = {
      --       temperature = 0.75,
      --       max_tokens = 32768,
      --     },
      --   },
      -- },
    },
    -- Lazy.nvim can't infer the correct Lua module name from the fork repo name,
    -- so configure explicitly.
    config = function(_, opts) require('avante').setup(opts) end,
    dependencies = {
      'nvim-lua/plenary.nvim',
      'MunifTanjim/nui.nvim',
      --- The below dependencies are optional,
      'nvim-mini/mini.pick', -- for file_selector provider mini.pick
      'nvim-telescope/telescope.nvim', -- for file_selector provider telescope
      'hrsh7th/nvim-cmp', -- autocompletion for avante commands and mentions
      'ibhagwan/fzf-lua', -- for file_selector provider fzf
      'stevearc/dressing.nvim', -- for input provider dressing
      'folke/snacks.nvim', -- for input provider snacks
      'nvim-tree/nvim-web-devicons', -- or echasnovski/mini.icons
      -- 'zbirenbaum/copilot.lua', -- for providers='copilot'
      {
        -- support for image pasting
        'HakonHarnes/img-clip.nvim',
        event = 'VeryLazy',
        opts = {
          -- recommended settings
          default = {
            embed_image_as_base64 = false,
            prompt_for_file_name = false,
            drag_and_drop = {
              insert_mode = true,
            },
            -- required for Windows users
            use_absolute_path = true,
          },
        },
      },
      {
        -- Make sure to set this up properly if you have lazy=true
        'MeanderingProgrammer/render-markdown.nvim',
        opts = {
          file_types = { 'markdown', 'Avante' },
        },
        ft = { 'markdown', 'Avante' },
      },
    },
  },
}
