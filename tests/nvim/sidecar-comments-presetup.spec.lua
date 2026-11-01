-- A source buffer read before setup() runs (for example, a restored session)
-- never saw BufReadPost; focusing Neovim must still place its threads.
local t = dofile(vim.fs.joinpath(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2)), 'support.lua'))

local path = t.source_with_thread { name = 'presetup.md', lines = { 'a', 'target' }, location = 'line:2' }
vim.cmd('edit ' .. path)

local sc = require 'custom.sidecar_comments'
sc.setup {}

local ok, err = pcall(vim.api.nvim_exec_autocmds, 'FocusGained', {})
t.check('focus does not throw for a buffer read before setup', ok, err)
t.check('thread placed after focus', #vim.api.nvim_buf_get_extmarks(0, sc.comment_ns_id, 0, -1, {}) == 1)

t.finish()
