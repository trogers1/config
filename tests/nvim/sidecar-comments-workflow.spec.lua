-- One continuous editing session: add, reply, hand-edit, move, jump, delete,
-- and pick up an agent's replies, as a user would in a single Neovim.
local t = dofile(vim.fs.joinpath(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2)), 'support.lua'))

local sc = require 'custom.sidecar_comments'
sc.setup { author_name = 'Tester' }

local src = t.dir .. '/doc.md'
local sidecar = src .. '.comments'
vim.fn.writefile({ '# Title', 'héllo world', 'third line', 'fourth line' }, src)

local function threads()
  return t.threads { sidecar = sidecar }
end

local function threads_by_id()
  local by_id = {}
  for _, thread in ipairs(threads()) do
    by_id[thread.id] = thread
  end
  return by_id
end

local function src_win()
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)) == src then
      return win
    end
  end
end

--- Replace the cleared placeholder line under the cursor with a body and save.
local function type_body(body)
  vim.cmd 'stopinsert'
  local line = vim.api.nvim_win_get_cursor(0)[1]
  vim.api.nvim_buf_set_lines(0, line - 1, line, false, { body })
  vim.cmd 'write'
end

-- Line comment from normal mode
vim.cmd('edit ' .. src)
local src_buf = vim.api.nvim_get_current_buf()
vim.api.nvim_win_set_cursor(0, { 3, 0 })
sc.add_line_comment()
vim.cmd 'stopinsert'
local side_buf = vim.api.nvim_get_current_buf()
t.check('sidecar opened', vim.api.nvim_buf_get_name(side_buf) == sidecar)
t.check('one thread at line:3', #threads() == 1 and threads()[1].location.line == 3, threads())
t.check('placeholder persisted on disk', threads()[1].messages[1].body == 'comment')
t.check('cursor on cleared body line', vim.api.nvim_get_current_line() == '', vim.api.nvim_get_current_line())
type_body 'First real comment'
t.check('body saved by hand edit', threads()[1].messages[1].body == 'First real comment', threads()[1].messages)
t.check('author name passed', threads()[1].messages[1].author.name == 'Tester')

-- Reply
sc.reply()
type_body 'A reply'
t.check('reply added', #threads()[1].messages == 2 and threads()[1].messages[2].body == 'A reply', threads()[1].messages)

-- Hand-written reply without metadata gets an ID on save, including a
-- bare role header with trailing ASCII spaces and tabs.
local lines = vim.api.nvim_buf_get_lines(side_buf, 0, -1, false)
local close = nil
for i, line in ipairs(lines) do
  if line:match '^%[/@th_' then
    close = i
  end
end
vim.api.nvim_buf_set_lines(side_buf, close - 1, close - 1, false, { '', '---user \t ', 'Hand reply' })
vim.cmd 'write'
local messages = threads()[1].messages
t.check('hand reply with trailing header whitespace accepted with ID', #messages == 3 and messages[3].body == 'Hand reply' and messages[3].id ~= nil, messages)
t.check(
  'buffer reloaded with meta',
  not vim.bo[side_buf].modified and table.concat(vim.api.nvim_buf_get_lines(side_buf, 0, -1, false), '\n'):find '---user <!%-%- sidecar%-meta' ~= nil
)

-- Source edits move the comment on save
vim.api.nvim_set_current_win(src_win())
vim.api.nvim_buf_set_lines(src_buf, 1, 1, false, { 'inserted above' })
vim.cmd 'write'
t.check('line comment moved to 4', threads()[1].location.line == 4, threads()[1].location)
t.check('sidecar buffer reloaded after move', vim.fn.getbufline(side_buf, 2)[1]:find 'line:4' ~= nil, vim.fn.getbufline(side_buf, 2))

-- Visual charwise selection over multibyte text: "héllo" on line 3
vim.api.nvim_win_set_cursor(0, { 3, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('ve<Space>sa', true, false, true), 'mx', false)
local range = vim.iter(threads()):find(function(thread)
  return thread.location.kind == 'range'
end)
t.check(
  'visual range uses exclusive byte end',
  range and vim.deep_equal(range.location, { kind = 'range', start_line = 3, start_column = 1, end_line = 3, end_column = 7 }),
  range and range.location
)
type_body 'Range comment'

-- Linewise visual over two lines becomes a range
vim.api.nvim_set_current_win(src_win())
vim.api.nvim_win_set_cursor(0, { 4, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('Vj<Space>sa', true, false, true), 'mx', false)
local multi = vim.iter(threads()):find(function(thread)
  return thread.location.kind == 'range' and thread.location.start_line == 4
end)
t.check(
  'linewise V spans lines as range',
  multi and vim.deep_equal(multi.location, { kind = 'range', start_line = 4, start_column = 1, end_line = 5, end_column = 12 }),
  multi and multi.location
)
type_body 'Multi-line comment'

-- Jump from source to comment and back
vim.api.nvim_set_current_win(src_win())
vim.api.nvim_win_set_cursor(0, { 3, 2 })
sc.jump_to_comment()
t.check('jump to comment lands on range header', vim.api.nvim_get_current_line():find(range.id, 1, true) ~= nil, vim.api.nvim_get_current_line())
sc.jump_to_source()
t.check(
  'jump back to source range start',
  vim.api.nvim_buf_get_name(0) == src and vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 3, 0 }),
  vim.api.nvim_win_get_cursor(0)
)

-- Moving the range, then deleting its text, makes it unresolved
vim.api.nvim_buf_set_lines(src_buf, 0, 0, false, { 'new first line' })
vim.cmd 'write'
t.check('range moved down a line', threads_by_id()[range.id].location.start_line == 4, threads_by_id()[range.id].location)
vim.api.nvim_buf_set_text(src_buf, 3, 0, 3, 6, {}) -- delete "héllo"
vim.cmd 'write'
t.check('deleted range becomes unresolved', threads_by_id()[range.id].location.kind == 'unresolved', threads_by_id()[range.id].location)
local diagnostics = vim.diagnostic.get(side_buf, { namespace = sc.diagnostic_ns_id })
t.check(
  'unresolved diagnostic in sidecar',
  #diagnostics == 1 and vim.fn.getbufline(side_buf, diagnostics[1].lnum + 1)[1]:find(range.id, 1, true) ~= nil,
  diagnostics
)

-- Deleting a commented line entirely
local line_thread = vim.iter(threads()):find(function(thread)
  return thread.location.kind == 'line'
end)
vim.api.nvim_buf_set_lines(src_buf, line_thread.location.line - 1, line_thread.location.line, false, {})
vim.cmd 'write'
t.check('deleted line becomes unresolved', threads_by_id()[line_thread.id].location.kind == 'unresolved', threads_by_id()[line_thread.id].location)

-- An agent reply plus a focus refresh keeps unsaved source moves
t.cli {
  args = { 'message', 'add', '--file', sidecar, '--thread', multi.id, '--author-kind', 'agent', '--body-file', '-' },
  stdin = 'Agent reply\n',
}
vim.api.nvim_buf_set_lines(src_buf, 0, 0, false, { 'unsaved line' })
vim.api.nvim_exec_autocmds('FocusGained', {})
vim.cmd 'write'
local moved = threads_by_id()[multi.id]
t.check('agent reply kept', #moved.messages == 2 and moved.messages[2].body == 'Agent reply', moved.messages)
-- On disk the range was at line 5; the unsaved insert above moved it to 6.
t.check('unsaved move survived focus refresh', moved.location.start_line == 6, moved.location)

-- Freshly opening a sidecar with unresolved threads shows diagnostics
vim.api.nvim_buf_delete(side_buf, { force = true })
vim.cmd('edit ' .. sidecar)
side_buf = vim.api.nvim_get_current_buf()
t.check('fresh open shows unresolved diagnostics', #vim.diagnostic.get(side_buf, { namespace = sc.diagnostic_ns_id }) == 2)

-- An outside reply reloads the unmodified comments buffer on focus
t.cli {
  args = { 'message', 'add', '--file', sidecar, '--thread', multi.id, '--author-kind', 'agent', '--body-file', '-' },
  stdin = 'Second agent reply\n',
}
vim.api.nvim_exec_autocmds('FocusGained', {})
t.check('focus reloads comments buffer', table.concat(vim.api.nvim_buf_get_lines(side_buf, 0, -1, false), '\n'):find('Second agent reply', 1, true) ~= nil)
t.check('diagnostics survive focus reload', #vim.diagnostic.get(side_buf, { namespace = sc.diagnostic_ns_id }) == 2)

-- An invalid hand edit is reported, not silently repaired
vim.api.nvim_buf_set_lines(side_buf, 1, 2, false, { 'garbage' })
local ok = pcall(vim.cmd, 'write')
diagnostics = vim.diagnostic.get(side_buf, { namespace = sc.diagnostic_ns_id })
t.check(
  'rejected file shows diagnostic',
  ok and #diagnostics > 0 and diagnostics[1].severity == vim.diagnostic.severity.ERROR and #diagnostics[1].message > 0,
  diagnostics
)
local rejected = vim.system({ 'sidecar', '--output', 'json', 'fix', '--add-missing-message-ids', '--file', sidecar }, { text = true }):wait()
local cli_error = vim.json.decode(rejected.stderr).error
local reported = cli_error.details and cli_error.details.diagnostics
if reported and #reported > 0 then
  t.check('real CLI diagnostics all rendered', #diagnostics == #reported, diagnostics)
  for i, diagnostic in ipairs(reported) do
    t.check(
      'real CLI diagnostic position and content ' .. i,
      diagnostics[i].lnum == (diagnostic.line or 1) - 1
        and diagnostics[i].col == (diagnostic.column or 1) - 1
        and diagnostics[i].code == diagnostic.code
        and diagnostics[i].message == diagnostic.message .. (diagnostic.hint and ('\n' .. diagnostic.hint) or ''),
      diagnostics[i]
    )
  end
end

-- Adding a comment while the sidecar buffer is dirty fails loudly
vim.api.nvim_buf_set_lines(side_buf, 1, 2, false, { 'still dirty' })
vim.cmd('buffer ' .. src_buf)
vim.api.nvim_win_set_cursor(0, { 1, 0 })
local add_ok, add_err = pcall(sc.add_line_comment)
t.check('dirty sidecar blocks add', not add_ok and tostring(add_err):find 'Save' ~= nil, tostring(add_err))

t.finish()
