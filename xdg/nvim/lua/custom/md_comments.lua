local M = {}

M.config = {
  sidecar_ext = '.comments',
  comment_pattern = '^%[(.-)%]%s*(.*)$',
  highlight_group = 'CommentLineNr',
  range_highlight_group = 'MdCommentRange',
  sign_priority = 10,
}

M.highlight_ns_id = vim.api.nvim_create_namespace 'md_comments_highlight'
M.comment_ns_id = vim.api.nvim_create_namespace 'md_comments_tracking'
M.diagnostic_ns_id = vim.api.nvim_create_namespace 'md_comments_diagnostics'
M.state = {
  by_md_path = {},
  next_id = 0,
}

local normalize_comment_for_buffer
local comment_is_deleted

local function valid_buf(bufnr)
  return bufnr and vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_is_loaded(bufnr)
end

local function get_buf_lines(bufnr)
  if not valid_buf(bufnr) then
    return {}
  end

  return vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
end

local function read_file_lines(filepath)
  local file = io.open(filepath, 'r')
  if not file then
    return {}
  end

  local lines = {}
  for line in file:lines() do
    table.insert(lines, line)
  end

  file:close()
  return lines
end

local function write_file_lines(filepath, lines)
  local file = assert(io.open(filepath, 'w'))

  for i, line in ipairs(lines) do
    file:write(line)
    if i < #lines then
      file:write '\n'
    end
  end

  file:close()
end

local function delete_file_if_exists(filepath)
  if vim.fn.filereadable(filepath) == 1 then
    vim.fn.delete(filepath)
  end
end

local function split_text_lines(text)
  if text == nil or text == '' then
    return { '' }
  end

  return vim.split(text, '\n', { plain = true, trimempty = false })
end

local function get_line_length(bufnr, line_num)
  local line = vim.api.nvim_buf_get_lines(bufnr, line_num - 1, line_num, false)[1] or ''
  return #line
end

local function find_buffer_by_name(filepath)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(buf) == filepath then
      return buf
    end
  end
end

local function get_or_create_state(md_path)
  local state = M.state.by_md_path[md_path]
  if not state then
    state = {
      comments = {},
      initialized = false,
      md_buf = nil,
    }
    M.state.by_md_path[md_path] = state
  end

  return state
end

local function new_comment_id()
  M.state.next_id = M.state.next_id + 1
  return string.format('c%x_%d', vim.uv.hrtime(), M.state.next_id)
end

local function parse_comment_header(header)
  local anchor_encoded
  local base_header, maybe_anchor = header:match '^(.-)%s+|%s+(.+)$'
  if base_header then
    header = base_header
    anchor_encoded = maybe_anchor
  end

  local anchor_text = nil
  if anchor_encoded then
    local ok, decoded = pcall(vim.base64.decode, anchor_encoded)
    if ok then
      anchor_text = decoded
    end
  end

  local id, reference = header:match '^@([^%s]+)%s+(.+)$'

  if not reference then
    reference = header
  end

  local location = M.parse_reference(reference)
  if not location then
    return nil
  end

  return {
    id = id,
    anchor_text = anchor_text,
    kind = (location.start_col and location.end_col) and 'range' or 'line',
    start_line = location.start_line,
    start_col = location.start_col,
    end_line = location.end_line,
    end_col = location.end_col,
  }
end

local function parse_sidecar_lines(lines)
  local comments = {}
  local current_comment = nil
  local seen_ids = {}

  for line_num, line in ipairs(lines) do
    local header, text = line:match(M.config.comment_pattern)
    local parsed = header and parse_comment_header(header) or nil

    if parsed then
      if current_comment then
        table.insert(comments, current_comment)
      end

      local comment_id = parsed.id
      if not comment_id or seen_ids[comment_id] then
        comment_id = new_comment_id()
      end
      seen_ids[comment_id] = true

      current_comment = {
        id = comment_id,
        anchor_text = parsed.anchor_text,
        kind = parsed.kind,
        start_line = parsed.start_line,
        start_col = parsed.start_col,
        end_line = parsed.end_line,
        end_col = parsed.end_col,
        text = text,
        sidecar_line = line_num,
      }
    elseif current_comment then
      current_comment.text = current_comment.text .. '\n' .. line
    end
  end

  if current_comment then
    table.insert(comments, current_comment)
  end

  return comments
end

local function get_current_location(state, comment)
  if not valid_buf(state.md_buf) or not comment.extmark_id then
    return {
      start_line = comment.start_line,
      start_col = comment.start_col,
      end_line = comment.end_line,
      end_col = comment.end_col,
    }
  end

  local extmark = vim.api.nvim_buf_get_extmark_by_id(state.md_buf, M.comment_ns_id, comment.extmark_id, { details = true })
  if #extmark == 0 then
    return {
      start_line = comment.start_line,
      start_col = comment.start_col,
      end_line = comment.end_line,
      end_col = comment.end_col,
    }
  end

  local details = extmark[3] or {}
  return {
    start_line = extmark[1] + 1,
    start_col = comment.kind == 'range' and (extmark[2] + 1) or nil,
    end_line = (details.end_row or extmark[1]) + 1,
    end_col = comment.kind == 'range' and (details.end_col or extmark[2]) or nil,
  }
end

local function get_text_for_location(bufnr, location)
  if not valid_buf(bufnr) then
    return ''
  end

  local normalized = normalize_comment_for_buffer(bufnr, {
    kind = 'range',
    start_line = location.start_line,
    start_col = location.start_col,
    end_line = location.end_line,
    end_col = location.end_col,
  })

  if normalized.start_line == normalized.end_line and normalized.start_col >= normalized.end_col then
    return ''
  end

  local lines = vim.api.nvim_buf_get_text(bufnr, normalized.start_line - 1, normalized.start_col, normalized.end_line - 1, normalized.end_col, {})

  return table.concat(lines, '\n')
end

local function get_current_comment_text(state, comment)
  if comment.kind ~= 'range' or not valid_buf(state.md_buf) then
    return nil
  end

  return get_text_for_location(state.md_buf, get_current_location(state, comment))
end

local function ensure_anchor_text(state, comment)
  if comment.kind ~= 'range' or comment.anchor_text ~= nil then
    return
  end

  comment.anchor_text = get_current_comment_text(state, comment)
end

local function refresh_comment_locations(state)
  if not valid_buf(state.md_buf) then
    return
  end

  for _, comment in ipairs(state.comments) do
    ensure_anchor_text(state, comment)
    local location = get_current_location(state, comment)
    comment.start_line = location.start_line
    comment.end_line = location.end_line

    if comment.kind == 'range' then
      comment.start_col = location.start_col
      comment.end_col = location.end_col
    else
      comment.start_col = nil
      comment.end_col = nil
    end
  end
end

normalize_comment_for_buffer = function(bufnr, comment)
  local line_count = math.max(vim.api.nvim_buf_line_count(bufnr), 1)
  local start_line = math.min(math.max(comment.start_line or 1, 1), line_count)
  local end_line = math.min(math.max(comment.end_line or start_line, start_line), line_count)

  if comment.kind == 'range' then
    local start_col = math.min(math.max((comment.start_col or 1) - 1, 0), get_line_length(bufnr, start_line))
    local end_col = math.min(math.max(comment.end_col or start_col, 0), get_line_length(bufnr, end_line))

    if start_line == end_line and end_col < start_col then
      end_col = start_col
    end

    return {
      start_line = start_line,
      start_col = start_col,
      end_line = end_line,
      end_col = end_col,
    }
  end

  return {
    start_line = start_line,
    start_col = 0,
    end_line = end_line,
    end_col = get_line_length(bufnr, end_line),
  }
end

local function apply_comments_to_md_buffer(state, md_buf)
  state.md_buf = md_buf
  vim.api.nvim_buf_clear_namespace(md_buf, M.comment_ns_id, 0, -1)

  for _, comment in ipairs(state.comments) do
    local location = normalize_comment_for_buffer(md_buf, comment)
    comment.start_line = location.start_line
    comment.end_line = location.end_line

    if comment.kind == 'range' then
      comment.start_col = location.start_col + 1
      comment.end_col = location.end_col
    else
      comment.start_col = nil
      comment.end_col = nil
    end

    comment.extmark_id = vim.api.nvim_buf_set_extmark(md_buf, M.comment_ns_id, location.start_line - 1, location.start_col, {
      end_row = location.end_line - 1,
      end_col = location.end_col,
      right_gravity = true,
      end_right_gravity = false,
      strict = false,
    })
  end
end

local function find_comment(state, comment_id)
  for _, comment in ipairs(state.comments) do
    if comment.id == comment_id then
      return comment
    end
  end
end

local function serialize_comment(comment)
  local reference = M.format_reference(comment.start_line, comment.end_line, comment.start_col, comment.end_col, comment.kind)
  local text_lines = split_text_lines(comment.text)
  local header = string.format('@%s %s', comment.id, reference)

  if comment.kind == 'range' and comment.anchor_text and comment.anchor_text ~= '' then
    header = string.format('%s | %s', header, vim.base64.encode(comment.anchor_text))
  end

  local serialized = { string.format('[%s] %s', header, text_lines[1] or '') }

  for i = 2, #text_lines do
    table.insert(serialized, text_lines[i])
  end

  return serialized
end

local function serialize_state(md_path)
  local state = get_or_create_state(md_path)
  refresh_comment_locations(state)

  local lines = {}
  local line_by_id = {}
  local line_range_by_id = {}

  for _, comment in ipairs(state.comments) do
    local start_line = #lines + 1
    local serialized = serialize_comment(comment)

    line_by_id[comment.id] = start_line
    line_range_by_id[comment.id] = {
      start_line = start_line,
      end_line = start_line + #serialized - 1,
    }

    vim.list_extend(lines, serialized)
  end

  return lines, line_by_id, line_range_by_id
end

local function set_sidecar_buffer_lines(sidecar_buf, lines, preserve_view)
  if not valid_buf(sidecar_buf) then
    return
  end

  local win = nil
  local cursor = nil

  if preserve_view then
    for _, candidate in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(candidate) == sidecar_buf then
        win = candidate
        cursor = vim.api.nvim_win_get_cursor(candidate)
        break
      end
    end
  end

  vim.api.nvim_buf_set_lines(sidecar_buf, 0, -1, false, lines)

  if win and cursor then
    local max_line = math.max(vim.api.nvim_buf_line_count(sidecar_buf), 1)
    vim.api.nvim_win_set_cursor(win, { math.min(cursor[1], max_line), cursor[2] })
  end
end

local function update_sidecar_deleted_comment_diagnostics(sidecar_buf, md_path, line_range_by_id)
  if not valid_buf(sidecar_buf) then
    return
  end

  local state = get_or_create_state(md_path)
  local diagnostics = {}
  local sidecar_lines = get_buf_lines(sidecar_buf)

  for _, comment in ipairs(state.comments) do
    if comment_is_deleted(state, comment) then
      local line_range = line_range_by_id[comment.id]
      if line_range then
        local end_line_text = sidecar_lines[line_range.end_line] or ''
        table.insert(diagnostics, {
          lnum = line_range.start_line - 1,
          end_lnum = line_range.end_line - 1,
          col = 0,
          end_col = math.max(#end_line_text, 1),
          severity = vim.diagnostic.severity.ERROR,
          source = 'md-comments',
          message = 'The text for this comment appears to have been deleted',
        })
      end
    end
  end

  vim.diagnostic.set(M.diagnostic_ns_id, sidecar_buf, diagnostics)
end

local function render_sidecar(md_path, opts)
  opts = opts or {}
  local sidecar_path = M.get_sidecar_path(md_path)
  local lines, line_by_id, line_range_by_id = serialize_state(md_path)
  local sidecar_buf = opts.sidecar_buf or find_buffer_by_name(sidecar_path)
  local sidecar_exists = vim.fn.filereadable(sidecar_path) == 1

  if opts.update_buffer and valid_buf(sidecar_buf) then
    set_sidecar_buffer_lines(sidecar_buf, lines, opts.preserve_view)
    update_sidecar_deleted_comment_diagnostics(sidecar_buf, md_path, line_range_by_id)
    if opts.mark_unmodified then
      vim.bo[sidecar_buf].modified = false
    end
  end

  if #lines == 0 then
    if sidecar_exists then
      delete_file_if_exists(sidecar_path)
    end

    if valid_buf(sidecar_buf) then
      vim.bo[sidecar_buf].modified = false
    end
  elseif opts.write_file then
    write_file_lines(sidecar_path, lines)
    if valid_buf(sidecar_buf) then
      vim.bo[sidecar_buf].modified = false
    end
  end

  return line_by_id
end

local function load_comments_for_md_buffer(md_buf)
  local md_path = vim.api.nvim_buf_get_name(md_buf)
  local sidecar_path = M.get_sidecar_path(md_path)
  local sidecar_buf = find_buffer_by_name(sidecar_path)
  local source_lines = valid_buf(sidecar_buf) and get_buf_lines(sidecar_buf) or read_file_lines(sidecar_path)
  local state = get_or_create_state(md_path)

  state.comments = parse_sidecar_lines(source_lines)
  state.initialized = true
  apply_comments_to_md_buffer(state, md_buf)

  return state
end

local function ensure_comments_for_md_buffer(md_buf)
  local md_path = vim.api.nvim_buf_get_name(md_buf)
  local state = get_or_create_state(md_path)

  if not state.initialized or state.md_buf ~= md_buf or not valid_buf(state.md_buf) then
    return load_comments_for_md_buffer(md_buf)
  end

  return state
end

local function merge_sidecar_into_state(md_path, comments, preserve_positions)
  local state = get_or_create_state(md_path)

  if preserve_positions then
    refresh_comment_locations(state)
  end

  local existing_by_id = {}
  for _, comment in ipairs(state.comments) do
    existing_by_id[comment.id] = comment
  end

  local merged = {}
  for _, parsed in ipairs(comments) do
    local comment = parsed.id and existing_by_id[parsed.id] or nil

    if comment then
      comment.text = parsed.text
      comment.kind = parsed.kind or comment.kind
      if parsed.anchor_text ~= nil then
        comment.anchor_text = parsed.anchor_text
      end
      if not preserve_positions then
        comment.start_line = parsed.start_line
        comment.start_col = parsed.start_col
        comment.end_line = parsed.end_line
        comment.end_col = parsed.end_col
      end
    else
      comment = {
        id = parsed.id or new_comment_id(),
        kind = parsed.kind,
        start_line = parsed.start_line,
        start_col = parsed.start_col,
        end_line = parsed.end_line,
        end_col = parsed.end_col,
        text = parsed.text,
        anchor_text = parsed.anchor_text,
      }
    end

    table.insert(merged, comment)
  end

  state.comments = merged
  state.initialized = true

  if valid_buf(state.md_buf) then
    apply_comments_to_md_buffer(state, state.md_buf)
  end

  return state
end

local function sync_state_from_sidecar_buffer(sidecar_buf, preserve_positions)
  local sidecar_path = vim.api.nvim_buf_get_name(sidecar_buf)
  local md_path = M.get_md_path(sidecar_path)
  local comments = parse_sidecar_lines(get_buf_lines(sidecar_buf))
  local state = get_or_create_state(md_path)

  if not valid_buf(state.md_buf) then
    state.md_buf = find_buffer_by_name(md_path)
  end

  return merge_sidecar_into_state(md_path, comments, preserve_positions)
end

function M.parse_reference(reference)
  local start_line, start_col, end_line, end_col = reference:match '^(%d+):(%d+)%-(%d+):(%d+)$'
  if start_line then
    return {
      start_line = tonumber(start_line),
      start_col = tonumber(start_col),
      end_line = tonumber(end_line),
      end_col = tonumber(end_col),
    }
  end

  start_line, start_col, end_col = reference:match '^(%d+):(%d+)%-(%d+)$'
  if start_line then
    return {
      start_line = tonumber(start_line),
      start_col = tonumber(start_col),
      end_line = tonumber(start_line),
      end_col = tonumber(end_col),
    }
  end

  start_line, end_line = reference:match '^(%d+)%-(%d+)$'
  if start_line then
    return {
      start_line = tonumber(start_line),
      end_line = tonumber(end_line),
    }
  end

  start_line = reference:match '^(%d+)$'
  if start_line then
    return {
      start_line = tonumber(start_line),
      end_line = tonumber(start_line),
    }
  end
end

function M.parse_sidecar(filepath)
  return parse_sidecar_lines(read_file_lines(filepath))
end

function M.get_sidecar_path(md_filepath)
  return md_filepath .. M.config.sidecar_ext
end

function M.get_md_path(sidecar_filepath)
  return sidecar_filepath:gsub(vim.pesc(M.config.sidecar_ext) .. '$', '')
end

function M.format_reference(start_line, end_line, start_col, end_col, kind)
  if kind == 'range' and start_col and end_col then
    return string.format('%d:%d-%d:%d', start_line, start_col, end_line, end_col)
  end

  if start_line == end_line then
    return tostring(start_line)
  end

  return string.format('%d-%d', start_line, end_line)
end

function M.format_comment(start_line, end_line, text, start_col, end_col, comment_id, kind)
  local range = M.format_reference(start_line, end_line, start_col, end_col, kind or ((start_col and end_col) and 'range' or 'line'))
  if comment_id then
    return string.format('[@%s %s] %s', comment_id, range, text)
  end
  return string.format('[%s] %s', range, text)
end

function M.comment_contains_position(comment, line_num, col_num)
  if line_num < comment.start_line or line_num > comment.end_line then
    return false
  end

  if comment.kind ~= 'range' or not comment.start_col or not comment.end_col then
    return true
  end

  if comment.start_line == comment.end_line then
    return col_num >= comment.start_col and col_num <= comment.end_col
  end

  if line_num == comment.start_line then
    return col_num >= comment.start_col
  end

  if line_num == comment.end_line then
    return col_num <= comment.end_col
  end

  return true
end

comment_is_deleted = function(state, comment)
  if comment.kind ~= 'range' or not comment.anchor_text or comment.anchor_text == '' then
    return false
  end

  return get_current_comment_text(state, comment) == ''
end

function M.open_sidecar(md_filepath, opts)
  opts = opts or {}
  local sidecar_path = M.get_sidecar_path(md_filepath)
  local sidecar_buf = find_buffer_by_name(sidecar_path)

  if sidecar_buf then
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(win) == sidecar_buf then
        vim.api.nvim_set_current_win(win)
        return sidecar_path
      end
    end
  end

  if opts.ensure_file and vim.fn.filereadable(sidecar_path) == 0 then
    local file = io.open(sidecar_path, 'w')
    if file then
      file:close()
    end
  end

  if sidecar_buf then
    vim.cmd(opts.vsplit and 'vsplit' or 'split')
    vim.api.nvim_win_set_buf(0, sidecar_buf)
  else
    vim.cmd(string.format('%s %s', opts.vsplit and 'vsplit' or 'split', vim.fn.fnameescape(sidecar_path)))
  end

  vim.bo.filetype = 'markdown'

  return sidecar_path
end

function M.jump_to_md_line()
  local line = vim.api.nvim_get_current_line()
  local header = line:match(M.config.comment_pattern)
  local parsed = header and parse_comment_header(header) or nil

  if not parsed then
    return
  end

  local current_file = vim.api.nvim_buf_get_name(0)
  local md_path = M.get_md_path(current_file)
  local md_buf = find_buffer_by_name(md_path)
  local location = {
    start_line = parsed.start_line,
    start_col = parsed.start_col,
    end_line = parsed.end_line,
    end_col = parsed.end_col,
  }

  if md_buf then
    local state = get_or_create_state(md_path)
    if not valid_buf(state.md_buf) or state.md_buf ~= md_buf then
      ensure_comments_for_md_buffer(md_buf)
      state = get_or_create_state(md_path)
    end

    if parsed.id then
      local comment = find_comment(state, parsed.id)
      if comment then
        location = get_current_location(state, comment)
      end
    end
  end

  if md_buf then
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(win) == md_buf then
        vim.api.nvim_set_current_win(win)
        vim.api.nvim_win_set_cursor(0, { location.start_line, math.max((location.start_col or 1) - 1, 0) })
        return
      end
    end
  end

  vim.cmd('edit ' .. vim.fn.fnameescape(md_path))
  vim.api.nvim_win_set_cursor(0, { location.start_line, math.max((location.start_col or 1) - 1, 0) })
end

function M.jump_to_comment()
  local md_buf = vim.api.nvim_get_current_buf()
  local md_path = vim.api.nvim_buf_get_name(md_buf)
  local sidecar_path = M.get_sidecar_path(md_path)
  local state = ensure_comments_for_md_buffer(md_buf)

  if #state.comments == 0 and vim.fn.filereadable(sidecar_path) == 0 then
    vim.notify('No comments file found', vim.log.levels.INFO)
    return
  end

  refresh_comment_locations(state)

  local cursor = vim.api.nvim_win_get_cursor(0)
  local current_line = cursor[1]
  local current_col = cursor[2] + 1

  for _, comment in ipairs(state.comments) do
    if M.comment_contains_position(comment, current_line, current_col) then
      M.open_sidecar(md_path, { vsplit = true })
      local sidecar_buf = vim.api.nvim_get_current_buf()
      local line_by_id = render_sidecar(md_path, {
        sidecar_buf = sidecar_buf,
        update_buffer = true,
        preserve_view = true,
      })
      local target_line = line_by_id[comment.id]

      if target_line then
        vim.api.nvim_win_set_cursor(0, { target_line, 0 })
      end
      return
    end
  end

  vim.notify('No comment found for current line', vim.log.levels.INFO)
end

function M.add_comment()
  return M.add_comment_for_range(vim.api.nvim_win_get_cursor(0)[1], vim.api.nvim_win_get_cursor(0)[1])
end

function M.add_comment_for_visual_selection()
  local selection_type = vim.fn.visualmode()
  local anchor = vim.fn.getpos 'v'
  local cursor = vim.fn.getpos '.'
  local start_line = anchor[2]
  local start_col = anchor[3]
  local end_line = cursor[2]
  local end_col = cursor[3]

  if start_line == 0 or end_line == 0 then
    vim.notify('No visual selection found', vim.log.levels.WARN)
    return
  end

  if selection_type == string.char(22) then
    vim.notify('Blockwise comment regions are not supported yet', vim.log.levels.WARN)
    return
  end

  if start_line > end_line or (start_line == end_line and start_col > end_col) then
    start_line, end_line = end_line, start_line
    start_col, end_col = end_col, start_col
  end

  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'n', false)

  if selection_type == 'V' then
    return M.add_comment_for_range(start_line, end_line)
  end

  return M.add_comment_for_range(start_line, end_line, start_col, end_col)
end

function M.add_comment_for_range(start_line, end_line, start_col, end_col)
  local md_buf = vim.api.nvim_get_current_buf()
  local md_path = vim.api.nvim_buf_get_name(md_buf)
  local state = ensure_comments_for_md_buffer(md_buf)

  refresh_comment_locations(state)

  local comment = {
    id = new_comment_id(),
    kind = (start_col and end_col) and 'range' or 'line',
    start_line = start_line,
    start_col = start_col,
    end_line = end_line,
    end_col = end_col,
    text = '',
  }

  table.insert(state.comments, comment)
  apply_comments_to_md_buffer(state, md_buf)

  M.open_sidecar(md_path, { vsplit = true, ensure_file = true })
  local sidecar_buf = vim.api.nvim_get_current_buf()
  local line_by_id = render_sidecar(md_path, {
    sidecar_buf = sidecar_buf,
    update_buffer = true,
    write_file = true,
    preserve_view = false,
    mark_unmodified = true,
  })
  local target_line = line_by_id[comment.id] or vim.api.nvim_buf_line_count(sidecar_buf)

  vim.api.nvim_win_set_cursor(0, { target_line, vim.fn.col '$' - 1 })
  vim.cmd 'startinsert!'
end

function M.setup_highlighting(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local filepath = vim.api.nvim_buf_get_name(bufnr)

  if not filepath:match '%.md$' then
    return
  end

  local state = get_or_create_state(filepath)
  if state.md_buf ~= bufnr or not valid_buf(state.md_buf) then
    state = ensure_comments_for_md_buffer(bufnr)
  end

  refresh_comment_locations(state)
  vim.api.nvim_buf_clear_namespace(bufnr, M.highlight_ns_id, 0, -1)
  vim.diagnostic.set(M.diagnostic_ns_id, bufnr, {})

  for _, comment in ipairs(state.comments) do
    local location = normalize_comment_for_buffer(bufnr, comment)
    local is_deleted = comment_is_deleted(state, comment)

    if is_deleted then
      goto continue
    end

    for line_num = location.start_line, location.end_line do
      vim.api.nvim_buf_set_extmark(bufnr, M.highlight_ns_id, line_num - 1, 0, {
        number_hl_group = M.config.highlight_group,
        priority = M.config.sign_priority,
      })
    end

    if comment.kind == 'range' then
      if location.start_line < location.end_line or location.start_col < location.end_col then
        vim.api.nvim_buf_set_extmark(bufnr, M.highlight_ns_id, location.start_line - 1, location.start_col, {
          end_row = location.end_line - 1,
          end_col = location.end_col,
          hl_group = M.config.range_highlight_group,
          priority = M.config.sign_priority,
          strict = false,
        })
      end
    else
      for line_num = location.start_line, location.end_line do
        vim.api.nvim_buf_set_extmark(bufnr, M.highlight_ns_id, line_num - 1, 0, {
          line_hl_group = M.config.range_highlight_group,
          priority = M.config.sign_priority,
        })
      end
    end

    ::continue::
  end
end

function M.setup_autocommands()
  local augroup = vim.api.nvim_create_augroup('MdComments', { clear = true })

  vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufNewFile' }, {
    group = augroup,
    pattern = '*.md',
    callback = function(args)
      ensure_comments_for_md_buffer(args.buf)
      M.setup_highlighting(args.buf)
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePost', {
    group = augroup,
    pattern = '*.md',
    callback = function(args)
      local md_path = vim.api.nvim_buf_get_name(args.buf)
      local sidecar_buf = find_buffer_by_name(M.get_sidecar_path(md_path))

      if valid_buf(sidecar_buf) then
        sync_state_from_sidecar_buffer(sidecar_buf, true)
      else
        ensure_comments_for_md_buffer(args.buf)
      end

      render_sidecar(md_path, {
        sidecar_buf = sidecar_buf,
        update_buffer = valid_buf(sidecar_buf),
        write_file = true,
        preserve_view = true,
        mark_unmodified = true,
      })
      M.setup_highlighting(args.buf)
    end,
  })

  vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufNewFile' }, {
    group = augroup,
    pattern = '*' .. M.config.sidecar_ext,
    callback = function(args)
      vim.bo[args.buf].filetype = 'markdown'
      vim.keymap.set('n', '<CR>', M.jump_to_md_line, { buffer = args.buf, desc = 'Jump to markdown line' })

      local md_path = M.get_md_path(vim.api.nvim_buf_get_name(args.buf))
      local md_buf = find_buffer_by_name(md_path)
      if md_buf then
        local state = get_or_create_state(md_path)
        state.md_buf = md_buf
        if #state.comments == 0 then
          ensure_comments_for_md_buffer(md_buf)
        else
          refresh_comment_locations(state)
        end

        render_sidecar(md_path, {
          sidecar_buf = args.buf,
          update_buffer = true,
          preserve_view = true,
          mark_unmodified = true,
        })
      else
        sync_state_from_sidecar_buffer(args.buf, false)
        render_sidecar(md_path, {
          sidecar_buf = args.buf,
          update_buffer = true,
          preserve_view = true,
          mark_unmodified = true,
        })
      end
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePre', {
    group = augroup,
    pattern = '*' .. M.config.sidecar_ext,
    callback = function(args)
      local md_path = M.get_md_path(vim.api.nvim_buf_get_name(args.buf))
      sync_state_from_sidecar_buffer(args.buf, false)
      render_sidecar(md_path, {
        sidecar_buf = args.buf,
        update_buffer = true,
        preserve_view = true,
      })
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePost', {
    group = augroup,
    pattern = '*' .. M.config.sidecar_ext,
    callback = function(args)
      local md_path = M.get_md_path(vim.api.nvim_buf_get_name(args.buf))
      local state = get_or_create_state(md_path)
      local md_buf = state.md_buf or find_buffer_by_name(md_path)

      if valid_buf(md_buf) then
        state.md_buf = md_buf
        M.setup_highlighting(md_buf)
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
    bg = '#fcefef',
  })

  M.setup_autocommands()

  vim.keymap.set('n', '<leader>mc', function()
    local md_buf = vim.api.nvim_get_current_buf()
    local md_path = vim.api.nvim_buf_get_name(md_buf)

    ensure_comments_for_md_buffer(md_buf)
    M.open_sidecar(md_path, { vsplit = true })
    render_sidecar(md_path, {
      sidecar_buf = vim.api.nvim_get_current_buf(),
      update_buffer = true,
      preserve_view = true,
      mark_unmodified = true,
    })
  end, { desc = '[M]arkdown [C]omments open' })

  vim.keymap.set('n', '<leader>mv', M.jump_to_comment, { desc = '[M]arkdown [V]iew comment' })
  vim.keymap.set('n', '<leader>ma', M.add_comment, { desc = '[M]arkdown [A]dd comment' })
  vim.keymap.set('x', '<leader>ma', M.add_comment_for_visual_selection, { desc = '[M]arkdown [A]dd comment for selection' })
end

return M
