-- Regressions from the two-reviewer review: each block is an isolated file
-- that once silently attached a thread to the wrong text, threw, or lost data.
local t = dofile(vim.fs.joinpath(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2)), 'support.lua'))
vim.o.autoread = true

local notes = {}
vim.notify = function(msg, level)
  table.insert(notes, { msg = msg, level = level })
end

local sc = require 'custom.sidecar_comments'
sc.setup {}

local function fresh_window()
  vim.cmd 'silent! only'
  vim.cmd 'enew!'
end

local function marks()
  return vim.api.nvim_buf_get_extmarks(0, sc.comment_ns_id, 0, -1, { details = true })
end

local function thread(path, id)
  return t.thread { sidecar = path .. '.comments', id = id }
end

local function keymap(opts)
  return vim.fn.maparg(opts.lhs, opts.mode, false, true).callback
end

-- `:w other` must not report the unsaved positions for the real source.
do
  fresh_window()
  local path, id = t.source_with_thread { name = 'write-other.md', lines = { 'a', 'b', 'target', 'd' }, location = 'line:3' }
  vim.cmd('edit ' .. path)
  vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'unsaved' })
  vim.cmd('write ' .. t.dir .. '/write-other-copy.md')
  local found = thread(path, id)
  t.check(':w other leaves thread untouched', found.location.line == 3 and found.tracking.selected_text == 'target', found)
  vim.cmd 'edit!'
end

-- Source changed outside Neovim without sync; open and :w with no edits.
do
  fresh_window()
  local path, id = t.source_with_thread { name = 'outside-edit.md', lines = { 'a', 'b', 'target', 'd' }, location = 'line:3' }
  vim.fn.writefile({ 'NEW1', 'NEW2', 'a', 'b', 'target', 'd' }, path)
  notes = {}
  vim.cmd('edit ' .. path)
  t.check('stale thread not placed on open', #marks() == 0, marks())
  t.check('warns about unplaced comment', #notes == 1 and notes[1].level == vim.log.levels.WARN, notes)
  vim.cmd 'write'
  local found = thread(path, id)
  t.check('save re-matches via sync', found.location.kind == 'line' and found.location.line == 5 and found.tracking.selected_text == 'target', found)
  t.check('thread placed after save', #marks() == 1 and marks()[1][2] == 4, marks())
end

-- :edit! after an outside edit above the thread resets stale marks.
do
  fresh_window()
  local path, id = t.source_with_thread { name = 'reload.md', lines = { 'a', 'b', 'target', 'd' }, location = 'line:3' }
  vim.cmd('edit ' .. path)
  t.check('placed on open', #marks() == 1)
  -- Let the mtime move so Neovim sees the outside write.
  vim.wait(1100)
  vim.fn.writefile({ 'NEW1', 'NEW2', 'a', 'b', 'target', 'd' }, path)
  vim.cmd 'edit!'
  t.check('no mark at stale row after reload', #marks() == 0, marks())
  vim.cmd 'write'
  local found = thread(path, id)
  t.check('save after reload keeps the right text', found.location.line == 5 and found.tracking.selected_text == 'target', found)
end

-- A line thread survives cc/S and a last-line rewrite; dd makes it unresolved.
do
  fresh_window()
  local path, id = t.source_with_thread { name = 'line-rewrite.md', lines = { 'a', 'target', 'c', 'last' }, location = 'line:2' }
  local last_id = t.create_thread { sidecar = path .. '.comments', location = 'line:4' }
  vim.cmd('edit ' .. path)
  vim.api.nvim_win_set_cursor(0, { 2, 0 })
  vim.cmd 'normal! ccrewritten'
  vim.api.nvim_win_set_cursor(0, { 4, 0 })
  vim.cmd 'normal! Sfinal'
  vim.cmd 'write'
  t.check('cc keeps line thread', vim.deep_equal(thread(path, id).location, { kind = 'line', line = 2 }), thread(path, id).location)
  t.check('S on last line keeps line thread', vim.deep_equal(thread(path, last_id).location, { kind = 'line', line = 4 }), thread(path, last_id).location)
  vim.api.nvim_win_set_cursor(0, { 2, 0 })
  vim.cmd 'normal! dd'
  vim.cmd 'write'
  t.check('dd makes line thread unresolved', thread(path, id).location.kind == 'unresolved', thread(path, id).location)
end

-- An agent creates a thread while the source has unsaved edits.
local agent_path
do
  fresh_window()
  local path = t.source_with_thread { name = 'agent-dirty.md', lines = { 'l1', 'l2', 'l3', 'target' }, location = 'line:1' }
  agent_path = path
  vim.cmd('edit ' .. path)
  vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'x', 'y' })
  local agent_id = t.create_thread { sidecar = path .. '.comments', location = 'line:4', author_kind = 'agent' }
  notes = {}
  vim.api.nvim_exec_autocmds('FocusGained', {})
  t.check('agent thread not placed on dirty buffer', #marks() == 1, marks())
  t.check('unplaced warning shown once', #notes == 1 and notes[1].level == vim.log.levels.WARN, notes)
  notes = {}
  vim.api.nvim_exec_autocmds('FocusGained', {})
  t.check('unplaced warning not repeated for same count', #notes == 0, notes)
  vim.cmd 'write'
  local found = thread(path, agent_id)
  t.check('save re-matches agent thread to its text', found.location.line == 6 and found.tracking.selected_text == 'target', found)
end

-- FocusGained with an unsaved sidecar edit must not throw.
do
  local side = sc.open_sidecar(agent_path)
  vim.api.nvim_buf_set_lines(side, 1, 2, false, { 'edited but unsaved' })
  local ok, err = pcall(vim.api.nvim_exec_autocmds, 'FocusGained', {})
  t.check('focus ignores modified sidecar', ok, err)
  vim.cmd 'edit!'
end

-- A rejected sidecar notifies on open; keymap CLI errors carry readable text.
do
  fresh_window()
  local path = t.dir .. '/old-format.md'
  vim.fn.writefile({ 'a' }, path)
  vim.fn.writefile({ '[@c1 1] old v1 format' }, path .. '.comments')
  notes = {}
  local open_ok, open_err = pcall(vim.cmd, 'edit ' .. path)
  t.check(
    'rejected sidecar on open notifies instead of throwing',
    open_ok and #notes == 1 and notes[1].level == vim.log.levels.ERROR and notes[1].msg:find 'validation' ~= nil,
    { open_err, notes }
  )
  local ok, err = pcall(keymap { lhs = '<Space>sa', mode = 'n' })
  t.check('keymap CLI error has text', not ok and type(err) == 'string' and err:find('validation', 1, true) ~= nil, err)
end

-- Replying from a blank line between threads is refused.
do
  fresh_window()
  local path = t.source_with_thread { name = 'between.md', lines = { 'a', 'b' }, location = 'line:1' }
  t.create_thread { sidecar = path .. '.comments', location = 'line:2' }
  vim.cmd('edit ' .. path .. '.comments')
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local blank
  for i, line in ipairs(lines) do
    if line == '' and lines[i - 1] and lines[i - 1]:match '^%[/@th_' then
      blank = i
    end
  end
  local function message_count()
    return vim.iter(t.threads { sidecar = path .. '.comments' }):fold(0, function(sum, found)
      return sum + #found.messages
    end)
  end
  vim.api.nvim_win_set_cursor(0, { blank, 0 })
  local before = message_count()
  local ok, err = pcall(sc.reply)
  t.check('reply between threads refused', not ok and message_count() == before, err)
end

-- An empty charwise selection is a clear error, without a traceback.
do
  fresh_window()
  local path = t.dir .. '/empty-selection.md'
  vim.fn.writefile({ 'a', '', 'c' }, path)
  vim.cmd('edit ' .. path)
  vim.api.nvim_win_set_cursor(0, { 2, 0 })
  vim.cmd 'normal! v'
  local ok, err = pcall(keymap { lhs = '<Space>sa', mode = 'x' })
  t.check('empty selection error', not ok and err == 'Select at least one character to comment on', err)
end

-- The source revision matches the CLI's for empty, no-final-newline and CRLF files.
for _, case in ipairs {
  { name = 'empty.md', bytes = '', line = 1 },
  { name = 'noeol.md', bytes = 'a\nb', line = 2 },
  { name = 'crlf.md', bytes = 'a\r\nb\r\n', line = 2 },
} do
  fresh_window()
  local path = t.dir .. '/' .. case.name
  local file = assert(io.open(path, 'wb'))
  file:write(case.bytes)
  file:close()
  local id = t.create_thread { sidecar = path .. '.comments', location = 'line:' .. case.line }
  vim.cmd('edit ' .. path)
  t.check('placed on open: ' .. case.name, #marks() == 1, marks())
  vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'top' })
  local ok, err = pcall(vim.cmd, 'write')
  t.check('save accepted: ' .. case.name, ok, err)
  local location = thread(path, id).location
  t.check('moved down: ' .. case.name, vim.deep_equal(location, { kind = 'line', line = case.line + 1 }), location)
  t.check('still placed after write: ' .. case.name, #marks() == 1, marks())
end

-- <leader>so inside a comments file is refused.
do
  vim.cmd('edit ' .. t.dir .. '/between.md.comments')
  local ok, err = pcall(keymap { lhs = '<Space>so', mode = 'n' })
  t.check('open from sidecar refused', not ok and tostring(err):find 'already a comments file' ~= nil, err)
end

-- Adding with a dirty sidecar fails before writing the source.
do
  fresh_window()
  local path = t.source_with_thread { name = 'dirty-sidecar.md', lines = { 'a', 'b' }, location = 'line:1' }
  vim.cmd('edit ' .. path .. '.comments')
  vim.api.nvim_buf_set_lines(0, 1, 2, false, { 'dirty' })
  vim.cmd('vsplit ' .. path)
  vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'unsaved source edit' })
  local ok = pcall(sc.add_line_comment)
  t.check('dirty sidecar refused without writing source', not ok and vim.bo.modified, vim.bo.modified)
  vim.cmd 'silent! only'
  vim.cmd 'edit!'
  vim.cmd('bwipeout! ' .. vim.fn.fnameescape(path .. '.comments'))
end

-- Files opened through a symlinked directory still update on save.
do
  fresh_window()
  local real = t.dir .. '/symlink-real'
  local link = t.dir .. '/symlink-link'
  local path, id = t.source_with_thread { name = 'symlink-real/s.md', lines = { 'a', 'target' }, location = 'line:2' }
  assert(vim.uv.fs_symlink(real, link))
  vim.cmd('edit ' .. link .. '/s.md')
  vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'top' })
  vim.cmd 'write'
  local found = thread(path, id)
  t.check('symlinked path save moves thread', found.location.line == 3 and found.tracking.selected_text == 'target', found.location)
  vim.cmd('edit ' .. link .. '/s.md.comments')
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  vim.api.nvim_buf_set_lines(0, #lines - 1, #lines - 1, false, { '', '---user', 'hand reply' })
  vim.cmd 'write'
  t.check('symlinked sidecar save runs fix', #thread(path, id).messages == 2 and thread(path, id).messages[2].id ~= nil, thread(path, id).messages)
end

-- When an agent deletes the last thread (removing the sidecar), saving clears its highlight.
do
  fresh_window()
  local path, id = t.source_with_thread { name = 'sidecar-removed.md', lines = { 'a', 'target' }, location = 'line:2' }
  vim.cmd('edit ' .. path)
  t.check('placed before removal', #marks() == 1)
  t.cli { args = { 'thread', 'delete', '--file', path .. '.comments', '--id', id } }
  t.check('sidecar removed by CLI', vim.fn.filereadable(path .. '.comments') == 0)
  vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'top' })
  vim.cmd 'write'
  t.check('highlight cleared on save', #marks() == 0, marks())
end

t.finish()
