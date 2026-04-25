local M = {}

local state = {
  win = nil,
  buf = nil,
}

local function close_popup()
  if state.win and vim.api.nvim_win_is_valid(state.win) then
    vim.api.nvim_win_close(state.win, true)
  end

  state.win = nil
  state.buf = nil
end

local function show_popup(message)
  close_popup()

  state.buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(state.buf, 0, -1, false, { message })

  local width = math.max(#message, 1)
  local height = 1
  local row = vim.o.lines - vim.o.cmdheight - height - 2
  local col = vim.o.columns - width - 3

  state.win = vim.api.nvim_open_win(state.buf, false, {
    relative = 'editor',
    row = math.max(row, 0),
    col = math.max(col, 0),
    width = width,
    height = height,
    style = 'minimal',
    border = 'rounded',
    focusable = false,
    noautocmd = true,
    zindex = 250,
  })

  vim.api.nvim_set_option_value('winhl', 'Normal:NormalFloat,FloatBorder:FloatBorder', { win = state.win })

  vim.defer_fn(close_popup, 1600)
end

local function format_message(counts, line_count)
  return string.format('%d words | %d lines | %d bytes', counts.words or 0, line_count, counts.bytes or 0)
end

local function count_visual_selection()
  local bufnr = vim.api.nvim_get_current_buf()
  local selection_type = vim.fn.mode()
  local anchor = vim.fn.getpos 'v'
  local cursor = vim.fn.getpos '.'

  local start_line = anchor[2]
  local start_col = anchor[3] - 1
  local end_line = cursor[2]
  local end_col = cursor[3]

  if start_line == 0 or end_line == 0 then
    return
  end

  if start_line > end_line or (start_line == end_line and start_col > end_col) then
    start_line, end_line = end_line, start_line
    start_col, end_col = end_col, start_col
  end

  local lines

  if selection_type == 'V' then
    lines = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, end_line, false)
  else
    local end_line_text = vim.api.nvim_buf_get_lines(bufnr, end_line - 1, end_line, false)[1] or ''
    local exclusive_end_col = math.min(end_col, #end_line_text)
    lines = vim.api.nvim_buf_get_text(bufnr, start_line - 1, start_col, end_line - 1, exclusive_end_col, {})
  end

  if #lines == 0 then
    return
  end

  local temp_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(temp_buf, 0, -1, false, lines)

  local counts = vim.api.nvim_buf_call(temp_buf, function()
    return vim.fn.wordcount()
  end)

  vim.api.nvim_buf_delete(temp_buf, { force = true })
  show_popup(format_message(counts, #lines))
end

function M.setup()
  vim.api.nvim_create_autocmd('BufWritePost', {
    desc = 'Show word count after save in writing mode',
    group = vim.api.nvim_create_augroup('WritingSaveStats', { clear = true }),
    callback = function(args)
      if vim.env.NVIM_CONTEXT ~= 'writing' or vim.bo[args.buf].buftype ~= '' then
        return
      end

      local counts = vim.api.nvim_buf_call(args.buf, function()
        return vim.fn.wordcount()
      end)
      local message = format_message(counts, vim.api.nvim_buf_line_count(args.buf))

      vim.schedule(function()
        if vim.api.nvim_buf_is_valid(args.buf) then
          show_popup(message)
        end
      end)
    end,
  })

  vim.keymap.set('x', '<leader>wc', count_visual_selection, { desc = '[W]ord [C]ount selection' })
end

return M
