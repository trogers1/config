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
      local message = string.format('%d words | %d lines | %d bytes', counts.words or 0, vim.api.nvim_buf_line_count(args.buf), counts.bytes or 0)

      vim.schedule(function()
        if vim.api.nvim_buf_is_valid(args.buf) then
          show_popup(message)
        end
      end)
    end,
  })
end

return M
