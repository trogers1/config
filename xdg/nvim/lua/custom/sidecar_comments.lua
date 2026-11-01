-- Neovim client for the `sidecar` CLI (https://github.com/trogers1/sidecar-comments).
--
-- The CLI owns the `.comments` format, IDs, ordering, source tracking, locking
-- and revisions.  This module only maps CLI locations to extmarks, reports
-- editor positions back on save, and drives the CLI from keymaps.  It never
-- parses or serializes `.comments` text itself.
local M = {}

M.config = {
  cmd = 'sidecar',
  sidecar_ext = '.comments',
  -- Body of a newly created thread or reply; the cursor lands on it to type over.
  placeholder = 'comment',
  author_name = nil,
  highlight_group = 'CommentLineNr',
  range_highlight_group = 'SidecarCommentRange',
  priority = 10,
}

M.protocol = 2
-- EditorUpdateRequest.updates maxItems in the CLI's v2 schema.
M.max_editor_updates = 256
M.comment_ns_id = vim.api.nvim_create_namespace 'sidecar_comments_tracking'
M.diagnostic_ns_id = vim.api.nvim_create_namespace 'sidecar_comments_diagnostics'
M.state = {
  by_src_path = {},
}

local CliError = {}
CliError.__index = CliError
CliError.__tostring = function(err)
  return string.format('sidecar %s failed for %s: %s', err.command, err.file, err.message)
end

-- Errors meaning the CLI refused to read the sidecar or source contents.
local REJECTED_CODES = { validation = true, repair = true }

--- Run one CLI command against a sidecar and return its JSON `result` and `changed`.
--- Throws a CliError carrying the CLI's error code on failure.
local function run_cli(opts)
  local cmd = { M.config.cmd, '--output', 'json' }
  vim.list_extend(cmd, opts.args)
  vim.list_extend(cmd, { '--file', opts.file })

  local completed = vim.system(cmd, { stdin = opts.stdin, text = true }):wait()
  local command = table.concat(opts.args, ' ')

  if completed.code ~= 0 then
    local ok, envelope = pcall(vim.json.decode, completed.stderr)
    if not ok or type(envelope) ~= 'table' or type(envelope.error) ~= 'table' then
      error(string.format('sidecar %s exited %d without a JSON error: %s', command, completed.code, completed.stderr))
    end
    error(setmetatable({
      command = command,
      file = opts.file,
      code = envelope.error.code,
      message = envelope.error.message,
      details = envelope.error.details,
    }, CliError))
  end

  local envelope = vim.json.decode(completed.stdout)
  if envelope.protocol ~= M.protocol then
    error(string.format('sidecar %s answered with protocol %s; this plugin speaks protocol %d', command, tostring(envelope.protocol), M.protocol))
  end
  return envelope.result, envelope.changed
end

local function is_rejected(err)
  return getmetatable(err) == CliError and REJECTED_CODES[err.code] == true
end

--- Wrap a keymap callback so a CliError surfaces as readable text: Neovim
--- prints an empty message for table errors raised from keymaps.
local function loud(fn)
  return function(...)
    local ok, message = xpcall(fn, function(err)
      if getmetatable(err) == CliError then
        return tostring(err)
      end
      return debug.traceback(err, 2)
    end, ...)
    if not ok then
      error(message, 0)
    end
  end
end

local function valid_buf(bufnr)
  return bufnr ~= nil and vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_is_loaded(bufnr)
end

local function find_buffer_by_name(filepath)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(buf) == filepath then
      return buf
    end
  end
end

local function is_sidecar_path(filepath)
  return vim.endswith(filepath, M.config.sidecar_ext)
end

local function is_source_buffer(bufnr)
  local filepath = vim.api.nvim_buf_get_name(bufnr)
  return filepath ~= '' and vim.bo[bufnr].buftype == '' and not is_sidecar_path(filepath)
end

function M.get_sidecar_path(src_filepath)
  return src_filepath .. M.config.sidecar_ext
end

function M.get_source_path(sidecar_filepath)
  return sidecar_filepath:sub(1, #sidecar_filepath - #M.config.sidecar_ext)
end

--- Whether the file on disk ends in a newline, as of the last read or write.
local function record_final_newline(opts)
  local bo = vim.bo[opts.bufnr]
  vim.b[opts.bufnr].sidecar_final_newline = bo.eol or (opts.after_write and bo.fixeol and not bo.binary)
end

--- The CLI's normalized source revision for the buffer's text, assuming the
--- file's final newline as last read or written.
local function buffer_revision(bufnr)
  local final_newline = vim.b[bufnr].sidecar_final_newline
  if final_newline == nil then
    error(string.format('No recorded read or write for %s', vim.api.nvim_buf_get_name(bufnr)))
  end

  local is_empty = vim.api.nvim_buf_call(bufnr, function()
    return vim.fn.line2byte(vim.fn.line '$' + 1) == -1
  end)
  if is_empty then
    return 'sha256:' .. vim.fn.sha256 ''
  end

  local text = table.concat(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false), '\n')
  return 'sha256:' .. vim.fn.sha256(text .. (final_newline and '\n' or ''))
end

local function author_args()
  local args = { '--author-kind', 'human' }
  if M.config.author_name then
    vim.list_extend(args, { '--author-name', M.config.author_name })
  end
  return args
end

--- Format a CLI location as a `--location` flag value.
local function location_arg(location)
  if location.kind == 'line' then
    return string.format('line:%d', location.line)
  end
  return string.format('range:%d:%d-%d:%d', location.start_line, location.start_column, location.end_line, location.end_column)
end

local function is_tracked(location)
  return location.kind == 'line' or location.kind == 'range'
end

local function reset_state(state)
  if valid_buf(state.src_buf) then
    vim.api.nvim_buf_clear_namespace(state.src_buf, M.comment_ns_id, 0, -1)
  end
  state.threads_by_id = {}
  state.loaded_location_by_id = {}
  state.extmark_by_thread_id = {}
  state.thread_id_by_extmark = {}
end

local function get_or_create_state(src_path)
  local state = M.state.by_src_path[src_path]
  if not state then
    state = {
      src_buf = nil,
      -- Locations as last read from the sidecar, to tell our extmark movement
      -- apart from moves made by another writer (for example, an agent).
      loaded_location_by_id = {},
      threads_by_id = {},
      extmark_by_thread_id = {},
      thread_id_by_extmark = {},
      unplaced_count = 0,
    }
    M.state.by_src_path[src_path] = state
  end
  return state
end

local function remove_extmark(state, thread_id)
  local extmark_id = state.extmark_by_thread_id[thread_id]
  if not extmark_id then
    return
  end
  vim.api.nvim_buf_del_extmark(state.src_buf, M.comment_ns_id, extmark_id)
  state.extmark_by_thread_id[thread_id] = nil
  state.thread_id_by_extmark[extmark_id] = nil
end

-- CLI coordinates are 1-based UTF-8 byte columns with exclusive range ends;
-- extmarks are 0-based byte columns with exclusive ends.  Range gravities keep
-- insertions at either boundary outside the selection, as the CLI requires.
-- Line threads are a zero-width mark at the line start, so rewriting the
-- line's text (`cc`, `S`) keeps it while deleting the line invalidates it.
local function place_extmark(state, thread)
  local location = thread.location
  local opts = {
    id = state.extmark_by_thread_id[thread.id],
    right_gravity = true,
    invalidate = true,
    number_hl_group = M.config.highlight_group,
    priority = M.config.priority,
  }
  local row, col

  if location.kind == 'line' then
    row, col = location.line - 1, 0
    opts.line_hl_group = M.config.range_highlight_group
  else
    row, col = location.start_line - 1, location.start_column - 1
    opts.end_row, opts.end_col = location.end_line - 1, location.end_column - 1
    opts.end_right_gravity = false
    opts.hl_group = M.config.range_highlight_group
  end

  local extmark_id = vim.api.nvim_buf_set_extmark(state.src_buf, M.comment_ns_id, row, col, opts)
  state.extmark_by_thread_id[thread.id] = extmark_id
  state.thread_id_by_extmark[extmark_id] = thread.id
end

--- The thread's current location in the buffer, or nil when its text was deleted.
local function extmark_location(state, thread)
  local extmark = vim.api.nvim_buf_get_extmark_by_id(state.src_buf, M.comment_ns_id, state.extmark_by_thread_id[thread.id], { details = true })
  local row, col, details = extmark[1], extmark[2], extmark[3]

  if details.invalid then
    return nil
  end

  if thread.location.kind == 'line' then
    return { kind = 'line', line = row + 1 }
  end

  if row == details.end_row and col == details.end_col then
    return nil
  end

  return {
    kind = 'range',
    start_line = row + 1,
    start_column = col + 1,
    end_line = details.end_row + 1,
    end_column = details.end_col + 1,
  }
end

--- Adopt a `thread list` result.  Threads whose stored location is unchanged
--- since we last read it keep their extmark, which may have moved with unsaved
--- edits.  Others are (re)placed only when their coordinates were captured
--- from exactly the buffer's current text; the rest stay unplaced until a save
--- lets `sidecar sync` re-match them.
local function apply_threads(state, result)
  local revision = buffer_revision(state.src_buf)
  local threads_by_id = {}
  local unplaced = 0

  for _, thread in ipairs(result.threads) do
    threads_by_id[thread.id] = thread
    local has_mark = state.extmark_by_thread_id[thread.id] ~= nil
    local unchanged = vim.deep_equal(thread.location, state.loaded_location_by_id[thread.id])

    if not is_tracked(thread.location) then
      remove_extmark(state, thread.id)
    elseif not (unchanged and has_mark) then
      if thread.tracking.source_revision == revision then
        place_extmark(state, thread)
      else
        remove_extmark(state, thread.id)
        unplaced = unplaced + 1
      end
    end
  end

  for thread_id in pairs(state.extmark_by_thread_id) do
    if not threads_by_id[thread_id] then
      remove_extmark(state, thread_id)
    end
  end

  state.threads_by_id = threads_by_id
  state.loaded_location_by_id = vim.iter(result.threads):fold({}, function(acc, thread)
    acc[thread.id] = thread.location
    return acc
  end)

  if unplaced > 0 and unplaced ~= state.unplaced_count then
    vim.notify(
      string.format(
        '%d comment(s) on %s do not match the current text; `sidecar sync` will try to re-match them when you save, and any it cannot find become unresolved',
        unplaced,
        vim.api.nvim_buf_get_name(state.src_buf)
      ),
      vim.log.levels.WARN
    )
  end
  state.unplaced_count = unplaced
end

local function list_threads(src_path)
  return run_cli { args = { 'thread', 'list' }, file = M.get_sidecar_path(src_path) }
end

--- Read the sidecar for a source buffer and show its threads.  `reset`
--- discards existing extmarks, which a reload leaves at stale rows.
local function load_source_buffer(opts)
  local src_buf = opts.bufnr
  local src_path = vim.api.nvim_buf_get_name(src_buf)
  local state = get_or_create_state(src_path)

  if opts.reset or state.src_buf ~= src_buf then
    reset_state(state)
    state.src_buf = src_buf
  end

  local ok, result = pcall(list_threads, src_path)
  if not ok then
    if not is_rejected(result) then
      error(result, 0)
    end
    reset_state(state)
    vim.notify(tostring(result), vim.log.levels.ERROR)
    return state
  end

  apply_threads(state, result)
  return state
end

local function find_line(bufnr, text)
  for line_num, line in ipairs(vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)) do
    if line:find(text, 1, true) then
      return line_num
    end
  end
end

--- Header line of a thread in a sidecar buffer.
local function find_thread_header(sidecar_buf, thread_id)
  local line_num = find_line(sidecar_buf, '[@th_' .. thread_id .. ' ')
  if not line_num then
    error(string.format('Thread %s is not in %s', thread_id, vim.api.nvim_buf_get_name(sidecar_buf)))
  end
  return line_num
end

--- Show unresolved threads, or the CLI's reason for rejecting the file.  Only
--- valid for a buffer whose text matches the file on disk.
local function update_sidecar_diagnostics(sidecar_buf)
  local sidecar_path = vim.api.nvim_buf_get_name(sidecar_buf)
  local ok, result = pcall(list_threads, M.get_source_path(sidecar_path))

  if not ok then
    if not is_rejected(result) then
      error(result, 0)
    end
    local repair = result.details and result.details.diagnostics and result.details.diagnostics[1]
    vim.diagnostic.set(M.diagnostic_ns_id, sidecar_buf, {
      {
        lnum = repair and repair.line and (repair.line - 1) or 0,
        col = 0,
        severity = vim.diagnostic.severity.ERROR,
        source = 'sidecar',
        message = string.format('Sidecar rejected this file (%s). Fix it and save again, or run :!sidecar validate --file %s', result.message, sidecar_path),
      },
    })
    return false
  end

  local diagnostics = {}
  for _, thread in ipairs(result.threads) do
    if thread.location.kind == 'unresolved' then
      table.insert(diagnostics, {
        lnum = find_thread_header(sidecar_buf, thread.id) - 1,
        col = 0,
        severity = vim.diagnostic.severity.WARN,
        source = 'sidecar',
        message = 'The text for this comment was deleted or could not be found in the source',
      })
    end
  end
  vim.diagnostic.set(M.diagnostic_ns_id, sidecar_buf, diagnostics)
  return true
end

local function windows_showing(bufnr)
  return vim.tbl_filter(function(win)
    return vim.api.nvim_win_get_buf(win) == bufnr
  end, vim.api.nvim_list_wins())
end

--- Reread a sidecar buffer after the CLI rewrote the file, keeping each window's view.
local function reload_sidecar_buffer(sidecar_buf)
  if vim.bo[sidecar_buf].modified then
    error(string.format('Refusing to reload %s over unsaved edits', vim.api.nvim_buf_get_name(sidecar_buf)))
  end

  local views = {}
  for _, win in ipairs(windows_showing(sidecar_buf)) do
    views[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
  end

  vim.api.nvim_buf_call(sidecar_buf, function()
    vim.cmd 'silent edit!'
  end)

  for win, view in pairs(views) do
    vim.api.nvim_win_call(win, function()
      vim.fn.winrestview(view)
    end)
  end

  -- Reloading clears diagnostics set during the reload's own BufReadPost.
  update_sidecar_diagnostics(sidecar_buf)
end

local function require_unmodified_sidecar(sidecar_path)
  local sidecar_buf = find_buffer_by_name(sidecar_path)
  if valid_buf(sidecar_buf) and vim.bo[sidecar_buf].modified then
    error(string.format('Save %s before changing comments from the source file', sidecar_path))
  end
end

--- ID of the thread enclosing the cursor in a sidecar buffer, or nil between threads.
local function thread_id_at_cursor()
  local cursor_line = vim.api.nvim_win_get_cursor(0)[1]
  local lines = vim.api.nvim_buf_get_lines(0, 0, cursor_line, false)
  for line_num = #lines, 1, -1 do
    local thread_id = lines[line_num]:match '^%[@th_([%x%-]+) '
    if thread_id then
      return thread_id
    end
    if line_num ~= cursor_line and lines[line_num]:match '^%[/@th_' then
      return nil
    end
  end
end

--- Put the cursor on a new message's placeholder body and start typing over it.
local function edit_placeholder(sidecar_buf, message_id)
  local meta_line = find_line(sidecar_buf, '"id":"' .. message_id .. '"')
  if not meta_line then
    error(string.format('Message %s is not in %s', message_id, vim.api.nvim_buf_get_name(sidecar_buf)))
  end

  vim.api.nvim_buf_set_lines(sidecar_buf, meta_line, meta_line + 1, false, { '' })
  vim.api.nvim_win_set_cursor(0, { meta_line + 1, 0 })
  vim.cmd 'startinsert'
end

--- Report the extmark positions of a just-saved source buffer to the CLI, and
--- let `sidecar sync` re-match threads that could not be placed.
local function update_locations(src_buf)
  local src_path = vim.api.nvim_buf_get_name(src_buf)
  local state = M.state.by_src_path[src_path]
  if not state or state.src_buf ~= src_buf then
    return
  end

  local sidecar_path = M.get_sidecar_path(src_path)
  if vim.fn.filereadable(sidecar_path) == 0 then
    return
  end

  local sidecar_buf = find_buffer_by_name(sidecar_path)
  if valid_buf(sidecar_buf) and vim.bo[sidecar_buf].modified then
    vim.notify(string.format('%s has unsaved edits; comment locations will be updated after you save it and then save the source again', sidecar_path), vim.log.levels.WARN)
    return
  end

  local current = list_threads(src_path)
  local updates = {}
  local needs_sync = false
  for _, thread in ipairs(current.threads) do
    if is_tracked(thread.location) or thread.location.kind == 'unresolved' then
      -- Skip threads that another writer moved or detached since we read them.
      if state.extmark_by_thread_id[thread.id] and vim.deep_equal(thread.location, state.loaded_location_by_id[thread.id]) then
        local location = extmark_location(state, thread)
        if location then
          table.insert(updates, { thread_id = thread.id, location = location })
        else
          table.insert(updates, { thread_id = thread.id, deleted = true })
        end
      elseif is_tracked(thread.location) then
        needs_sync = true
      end
    end
  end

  if #updates > M.max_editor_updates then
    error(string.format('%s has %d tracked comments; the sidecar CLI accepts at most %d editor updates per save', sidecar_path, #updates, M.max_editor_updates))
  end

  local changed = false
  if #updates > 0 then
    -- The CLI checks this revision against the saved file under its lock, so
    -- a file that differs from the buffer fails with conflict:source_revision.
    local _, update_changed = run_cli {
      args = { 'editor-update', '--operations-file', '-' },
      file = sidecar_path,
      stdin = vim.json.encode {
        protocol = M.protocol,
        if_revision = current.storage_revision,
        source_revision = buffer_revision(src_buf),
        updates = updates,
      },
    }
    changed = update_changed
  end

  if needs_sync then
    local _, sync_changed = run_cli { args = { 'sync' }, file = sidecar_path }
    changed = changed or sync_changed
  end

  if changed then
    load_source_buffer { bufnr = src_buf }
    if valid_buf(sidecar_buf) then
      reload_sidecar_buffer(sidecar_buf)
    end
  else
    apply_threads(state, current)
  end
end

--- Assign IDs to hand-written messages after the sidecar buffer is saved.
local function fix_sidecar_buffer(sidecar_buf)
  local sidecar_path = vim.api.nvim_buf_get_name(sidecar_buf)
  local ok, result_or_err, changed = pcall(run_cli, { args = { 'fix', '--add-missing-message-ids' }, file = sidecar_path })

  if not ok and not is_rejected(result_or_err) then
    error(result_or_err, 0)
  end

  if ok and changed then
    reload_sidecar_buffer(sidecar_buf)
  elseif not update_sidecar_diagnostics(sidecar_buf) then
    return
  end

  local src_buf = find_buffer_by_name(M.get_source_path(sidecar_path))
  if valid_buf(src_buf) then
    load_source_buffer { bufnr = src_buf }
  end
end

function M.open_sidecar(src_filepath)
  if is_sidecar_path(src_filepath) then
    error(string.format('%s is already a comments file', src_filepath))
  end

  local sidecar_path = M.get_sidecar_path(src_filepath)
  local sidecar_buf = find_buffer_by_name(sidecar_path)

  if sidecar_buf then
    local win = windows_showing(sidecar_buf)[1]
    if win then
      vim.api.nvim_set_current_win(win)
      return vim.api.nvim_get_current_buf()
    end
    vim.cmd 'vsplit'
    vim.api.nvim_win_set_buf(0, sidecar_buf)
  else
    vim.cmd('vsplit ' .. vim.fn.fnameescape(sidecar_path))
  end

  return vim.api.nvim_get_current_buf()
end

function M.jump_to_source()
  local thread_id = thread_id_at_cursor()
  if not thread_id then
    vim.notify('No comment thread at the cursor', vim.log.levels.INFO)
    return
  end

  local src_path = M.get_source_path(vim.api.nvim_buf_get_name(0))
  local src_buf = find_buffer_by_name(src_path)
  local win = src_buf and windows_showing(src_buf)[1]

  if win then
    vim.api.nvim_set_current_win(win)
  else
    vim.cmd('edit ' .. vim.fn.fnameescape(src_path))
  end

  local state = M.state.by_src_path[src_path]
  local extmark_id = state and state.src_buf == vim.api.nvim_get_current_buf() and state.extmark_by_thread_id[thread_id]
  if not extmark_id then
    local thread = state and state.threads_by_id[thread_id]
    local kind = thread and thread.location.kind or 'not placed'
    vim.notify(string.format('This comment is not attached to a location in the source (%s)', kind), vim.log.levels.INFO)
    return
  end

  local extmark = vim.api.nvim_buf_get_extmark_by_id(state.src_buf, M.comment_ns_id, extmark_id, {})
  vim.api.nvim_win_set_cursor(0, { extmark[1] + 1, extmark[2] })
end

function M.jump_to_comment()
  local src_buf = vim.api.nvim_get_current_buf()
  local src_path = vim.api.nvim_buf_get_name(src_buf)
  local state = M.state.by_src_path[src_path]
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  row = row - 1

  local thread_id = nil
  if state and state.src_buf == src_buf then
    local marks = vim.api.nvim_buf_get_extmarks(src_buf, M.comment_ns_id, { row, 0 }, { row, -1 }, { details = true, overlap = true })
    for _, mark in ipairs(marks) do
      local mark_row, mark_col, details = mark[2], mark[3], mark[4]
      if not details.invalid then
        -- Line marks are zero-width and cover their whole row.
        local covers_cursor = details.end_row == nil
          or ((row > mark_row or col >= mark_col) and (row < details.end_row or col < details.end_col))
        -- Prefer the comment under the cursor; fall back to any on this line.
        if not thread_id or covers_cursor then
          thread_id = state.thread_id_by_extmark[mark[1]]
        end
      end
    end
  end

  if not thread_id then
    vim.notify('No comment found for the current line', vim.log.levels.INFO)
    return
  end

  local sidecar_buf = M.open_sidecar(src_path)
  vim.api.nvim_win_set_cursor(0, { find_thread_header(sidecar_buf, thread_id), 0 })
end

function M.add_comment(location)
  local src_buf = vim.api.nvim_get_current_buf()
  if not is_source_buffer(src_buf) then
    error 'Comments can only be added to a file buffer'
  end

  local src_path = vim.api.nvim_buf_get_name(src_buf)
  local sidecar_path = M.get_sidecar_path(src_path)
  require_unmodified_sidecar(sidecar_path)

  -- The CLI captures the commented text from the saved file.
  if vim.bo[src_buf].modified then
    vim.cmd 'write'
  end

  local args = { 'thread', 'create', '--location', location_arg(location), '--body-file', '-' }
  vim.list_extend(args, author_args())
  local created = run_cli { args = args, file = sidecar_path, stdin = M.config.placeholder .. '\n' }

  load_source_buffer { bufnr = src_buf }
  local sidecar_buf = M.open_sidecar(src_path)
  reload_sidecar_buffer(sidecar_buf)
  edit_placeholder(sidecar_buf, created.generated_ids.message_id)
end

function M.add_line_comment()
  M.add_comment { kind = 'line', line = vim.api.nvim_win_get_cursor(0)[1] }
end

function M.add_comment_for_visual_selection()
  local mode = vim.fn.mode()
  local anchor = vim.fn.getpos 'v'
  local cursor = vim.fn.getpos '.'
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'nx', false)

  if mode == '\22' then
    error 'Blockwise comment regions are not supported'
  end

  local start_line, start_col, end_line, end_col = anchor[2], anchor[3], cursor[2], cursor[3]
  if start_line > end_line or (start_line == end_line and start_col > end_col) then
    start_line, end_line = end_line, start_line
    start_col, end_col = end_col, start_col
  end

  local end_text = vim.fn.getline(end_line)

  if mode == 'V' then
    if start_line == end_line then
      return M.add_comment { kind = 'line', line = start_line }
    end
    return M.add_comment { kind = 'range', start_line = start_line, start_column = 1, end_line = end_line, end_column = #end_text + 1 }
  end

  -- Visual ends are inclusive and point at the first byte of the last
  -- character (or past the line end after `$`); the CLI wants the byte after it.
  local end_column = 1
  if #end_text > 0 then
    local last_byte = math.min(end_col, #end_text)
    end_column = last_byte + vim.str_utf_end(end_text, last_byte) + 1
  end

  if start_line == end_line and start_col >= end_column then
    error 'Select at least one character to comment on'
  end

  return M.add_comment { kind = 'range', start_line = start_line, start_column = start_col, end_line = end_line, end_column = end_column }
end

function M.reply()
  local sidecar_buf = vim.api.nvim_get_current_buf()
  local sidecar_path = vim.api.nvim_buf_get_name(sidecar_buf)
  local thread_id = thread_id_at_cursor()
  if not thread_id then
    error 'Put the cursor inside a comment thread to reply'
  end
  if vim.bo[sidecar_buf].modified then
    error 'Save this file before replying'
  end

  local args = { 'message', 'add', '--thread', thread_id, '--body-file', '-' }
  vim.list_extend(args, author_args())
  local added = run_cli { args = args, file = sidecar_path, stdin = M.config.placeholder .. '\n' }

  reload_sidecar_buffer(sidecar_buf)
  edit_placeholder(sidecar_buf, added.generated_id)
end

--- Whether a write event saved the buffer to its own file (not `:w other`).
--- `args.file` is the path as typed; the buffer name may be symlink-resolved.
local function wrote_own_file(args)
  return vim.fn.resolve(vim.fn.fnamemodify(args.file, ':p')) == vim.fn.resolve(vim.api.nvim_buf_get_name(args.buf)) and not vim.bo[args.buf].modified
end

function M.setup_autocommands()
  local augroup = vim.api.nvim_create_augroup('SidecarComments', { clear = true })

  vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufNewFile' }, {
    group = augroup,
    callback = function(args)
      if not is_source_buffer(args.buf) then
        return
      end
      record_final_newline { bufnr = args.buf, after_write = false }
      local state = M.state.by_src_path[vim.api.nvim_buf_get_name(args.buf)]
      if vim.fn.filereadable(M.get_sidecar_path(vim.api.nvim_buf_get_name(args.buf))) == 1 or state then
        load_source_buffer { bufnr = args.buf, reset = true }
      end
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePost', {
    group = augroup,
    callback = function(args)
      if is_source_buffer(args.buf) and wrote_own_file(args) then
        record_final_newline { bufnr = args.buf, after_write = true }
        update_locations(args.buf)
      end
    end,
  })

  vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufNewFile' }, {
    group = augroup,
    pattern = '*' .. M.config.sidecar_ext,
    callback = function(args)
      vim.bo[args.buf].filetype = 'markdown'
      vim.keymap.set('n', '<CR>', loud(M.jump_to_source), { buffer = args.buf, desc = '🛵 Jump to source' })
      vim.keymap.set('n', '<leader>sr', loud(M.reply), { buffer = args.buf, desc = '🛵 [S]idecarComments [R]eply' })
      if vim.fn.filereadable(vim.api.nvim_buf_get_name(args.buf)) == 1 then
        update_sidecar_diagnostics(args.buf)
      end
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePost', {
    group = augroup,
    pattern = '*' .. M.config.sidecar_ext,
    callback = function(args)
      if wrote_own_file(args) then
        fix_sidecar_buffer(args.buf)
      end
    end,
  })

  -- Pick up replies, moves and new threads written by other processes while
  -- Neovim was in the background.  `:checktime` is postponed inside
  -- autocommands, so reload unmodified sidecar buffers directly; modified
  -- ones are left alone because their text no longer matches the file.
  vim.api.nvim_create_autocmd('FocusGained', {
    group = augroup,
    callback = function()
      for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if valid_buf(buf) then
          local filepath = vim.api.nvim_buf_get_name(buf)
          if is_sidecar_path(filepath) then
            if vim.fn.filereadable(filepath) == 1 and not vim.bo[buf].modified and not vim.deep_equal(vim.api.nvim_buf_get_lines(buf, 0, -1, false), vim.fn.readfile(filepath)) then
              reload_sidecar_buffer(buf)
            end
          elseif is_source_buffer(buf) and (vim.fn.filereadable(M.get_sidecar_path(filepath)) == 1 or M.state.by_src_path[filepath]) then
            load_source_buffer { bufnr = buf }
          end
        end
      end
    end,
  })
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})

  vim.api.nvim_set_hl(0, M.config.highlight_group, {
    bg = '#7f1d1d',
    fg = '#ffd7d7',
    bold = true,
  })
  vim.api.nvim_set_hl(0, M.config.range_highlight_group, {
    bg = vim.o.background == 'dark' and '#3f1d1d' or '#fcefef',
  })

  M.setup_autocommands()

  vim.keymap.set(
    'n',
    '<leader>so',
    loud(function()
      M.open_sidecar(vim.api.nvim_buf_get_name(0))
    end),
    { desc = '🛵 [S]idecarComments [O]pen' }
  )
  vim.keymap.set('n', '<leader>sv', loud(M.jump_to_comment), { desc = '🛵 [S]idecarComments [V]iew' })
  vim.keymap.set('n', '<leader>sa', loud(M.add_line_comment), { desc = '🛵 [S]idecarComments [A]dd' })
  vim.keymap.set('x', '<leader>sa', loud(M.add_comment_for_visual_selection), { desc = '🛵 [S]idecarComments [A]dd for selection' })
end

return M
