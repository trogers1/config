-- Neo-tree is a Neovim plugin to browse the file system
-- https://github.com/nvim-neo-tree/neo-tree.nvim

return {
  {
    'nvim-neo-tree/neo-tree.nvim',
    version = '*',
    dependencies = {
      'nvim-lua/plenary.nvim',
      'nvim-tree/nvim-web-devicons', -- not strictly required, but recommended
      'MunifTanjim/nui.nvim',
    },
    cmd = 'Neotree',
    keys = {
      { '\\', ':Neotree reveal<CR>', desc = 'NeoTree reveal', silent = true },
    },
    opts = {
      filesystem = {
        window = {
          mappings = {
            ['\\'] = 'close_window',
            ['y'] = 'noop', -- Disable default copy_to_clipboard mapping
            ['yf'] = {
              function(state)
                local node = state.tree:get_node()
                if node.type ~= 'file' then
                  vim.notify('Can only copy contents of files', vim.log.levels.WARN)
                  return
                end

                local filepath = node:get_id()
                local file = io.open(filepath, 'r')
                if not file then
                  vim.notify('Cannot read file: ' .. filepath, vim.log.levels.ERROR)
                  return
                end

                local content = file:read '*all'
                file:close()

                if content and content ~= '' then
                  vim.fn.setreg('+', content)
                  vim.notify('Copied file contents to clipboard', vim.log.levels.INFO)
                else
                  vim.notify('File is empty or cannot be read', vim.log.levels.WARN)
                end
              end,
              desc = 'Copy file contents to clipboard',
            },
            ['yy'] = {
              function(state)
                local node = state.tree:get_node()
                local filepath = node:get_id()
                vim.fn.setreg('+', filepath)
                vim.notify('Copied absolute path: ' .. filepath, vim.log.levels.INFO)
              end,
              desc = 'Copy absolute path to clipboard',
            },
            ['YY'] = {
              function(state)
                local node = state.tree:get_node()
                local filepath = node:get_id()
                local root_path = state.path

                -- Calculate relative path from Neo-tree root
                local relative_path
                if root_path and root_path ~= '' and filepath:find(root_path, 1, true) == 1 then
                  relative_path = filepath:sub(#root_path + 2) -- +2 to skip the trailing slash
                else
                  relative_path = vim.fn.fnamemodify(filepath, ':.')
                end

                vim.fn.setreg('+', relative_path)
                vim.notify('Copied relative path: ' .. relative_path, vim.log.levels.INFO)
              end,
              desc = 'Copy relative path to clipboard',
            },
          },
        },
      },
    },
  },
  {
    -- Bridges Neo-tree file moves/renames to the LSP; kept after Neo-tree because it subscribes to Neo-tree events.
    'antosha417/nvim-lsp-file-operations',
    dependencies = {
      'nvim-lua/plenary.nvim',
      'nvim-neo-tree/neo-tree.nvim',
    },
    config = function()
      require('lsp-file-operations').setup()
    end,
  },
}
