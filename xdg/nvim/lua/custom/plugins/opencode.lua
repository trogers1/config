return {
  {
    'opencode',
    dir = vim.fn.stdpath 'config',
    name = 'opencode',
    config = function()
      local opencode = require 'custom.opencode'

      opencode.setup()

      local ok, wk = pcall(require, 'which-key')
      if ok then
        wk.add({
          { '<leader>o', group = 'Opencode', mode = { 'n', 'v' } },
        })
      end

      local function map_agent(key, agent, label)
        vim.keymap.set({ 'n', 'v' }, '<leader>oc' .. key, function()
          if opencode.is_opencode_buffer(vim.api.nvim_get_current_buf()) then
            opencode.run_followup(agent)
          else
            opencode.run(agent)
          end
        end, { desc = 'Opencode prompt (' .. label .. ')' })
      end

      map_agent('p', 'plan', 'plan')
      map_agent('b', 'build', 'build')

      vim.keymap.set('n', '<leader>oca', function()
        opencode.apply_last_diff()
      end, { desc = 'Opencode apply last diff' })
    end,
  },
}
