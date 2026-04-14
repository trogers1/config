local M = {}

M.config = {
  path = vim.fn.stdpath 'config' .. '/vim_cheatsheet.md',
  write_tip_throttle_ms = 5 * 60 * 1000,
}

M.state = {
  last_tip_at = 0,
}

local function trim(s)
  return s:match '^%s*(.-)%s*$'
end

local function fallback_tips()
  return {
    '💡 Use `<C-o>` and `<C-i>` to navigate your jumplist',
    '🔍 Press `<C-q>` in Telescope to add results to quickfix list',
    '⚡ Record macros with `q<letter>` and replay with `@<letter>`',
  }
end

local function extract_tips()
  local tips = {}
  local file = io.open(M.config.path, 'r')

  if not file then
    return fallback_tips()
  end

  local current_section = ''
  local in_pro_tips = false

  for line in file:lines() do
    local section = line:match '^## (.+)'
    if section then
      current_section = section:gsub('[🔧📝🔍🔭📁🛠️🎯💡]', '')
      current_section = trim(current_section)
      in_pro_tips = current_section:find 'Pro Tips' ~= nil
    end

    local command, description = line:match '^| (`[^`]+`) | (.+) |$'
    if command and description then
      description = description:gsub('%*%*(.-)%*%*', '%1')
      description = description:gsub('_%*(.-)%*_', '%1')
      description = description:gsub('%[(.-)%]', '%1')
      description = trim(description)

      table.insert(tips, string.format('Use %s to %s', command, description:lower()))
    end

    if in_pro_tips then
      local pro_tip, pro_tip_desc = line:match '^%d+%. %*%*(.-)%*%*: (.+)'
      if pro_tip and pro_tip_desc then
        table.insert(tips, string.format('💡 %s: %s', pro_tip, pro_tip_desc))
      else
        local simple_tip = line:match '^%d+%. (.+)'
        if simple_tip then
          table.insert(tips, '💡 ' .. simple_tip)
        end
      end
    end
  end

  file:close()

  if #tips == 0 then
    return fallback_tips()
  end

  return tips
end

local function show_random_tip()
  local tips = extract_tips()
  math.randomseed(os.time())
  local tip = tips[math.random(#tips)]

  local width = math.min(80, vim.o.columns - 4)
  local height = 6
  local buf = vim.api.nvim_create_buf(false, true)

  local ui = vim.api.nvim_list_uis()[1]
  local win_width = ui.width
  local win_height = ui.height
  local row = math.ceil((win_height - height) / 2)
  local col = math.ceil((win_width - width) / 2)

  local opts = {
    style = 'minimal',
    relative = 'editor',
    width = width,
    height = height,
    row = row,
    col = col,
    border = 'rounded',
    title = ' 💡 Neovim Tip of the Day ',
    title_pos = 'center',
  }

  local win = vim.api.nvim_open_win(buf, false, opts)

  local wrapped_tip = tip
  if #tip > width - 6 then
    local words = {}
    for word in tip:gmatch '%S+' do
      table.insert(words, word)
    end

    local lines = {}
    local current_line = ''

    for _, word in ipairs(words) do
      if #current_line + #word + 1 <= width - 6 then
        current_line = current_line == '' and word or current_line .. ' ' .. word
      else
        table.insert(lines, current_line)
        current_line = word
      end
    end

    if current_line ~= '' then
      table.insert(lines, current_line)
    end

    wrapped_tip = table.concat(lines, '\n  ')
  end

  local content_lines = { '', '  ' .. wrapped_tip, '', '  Press any key to dismiss...', '' }

  if wrapped_tip:find '\n' then
    content_lines = { '' }
    for line in wrapped_tip:gmatch '[^\n]+' do
      table.insert(content_lines, '  ' .. line)
    end
    table.insert(content_lines, '')
    table.insert(content_lines, '  Press any key to dismiss...')
    table.insert(content_lines, '')

    height = #content_lines + 2
    opts.height = height
    opts.row = math.ceil((win_height - height) / 2)
    vim.api.nvim_win_close(win, true)
    win = vim.api.nvim_open_win(buf, false, opts)
  end

  vim.api.nvim_buf_set_lines(buf, 0, -1, false, content_lines)
  vim.api.nvim_buf_set_option(buf, 'modifiable', false)
  vim.api.nvim_buf_set_option(buf, 'bufhidden', 'wipe')
  vim.api.nvim_win_set_option(win, 'winhl', 'Normal:Normal,FloatBorder:FloatBorder')

  local timer = vim.loop.new_timer()
  timer:start(
    8000,
    0,
    vim.schedule_wrap(function()
      if vim.api.nvim_win_is_valid(win) then
        vim.api.nvim_win_close(win, true)
      end
      timer:close()
    end)
  )

  vim.keymap.set('n', '<Esc>', function()
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_close(win, true)
    end
    if timer then
      timer:close()
    end
  end, { buffer = buf, silent = true })

  vim.api.nvim_create_autocmd({ 'BufLeave', 'CursorMoved', 'InsertEnter' }, {
    buffer = buf,
    once = true,
    callback = function()
      if vim.api.nvim_win_is_valid(win) then
        vim.api.nvim_win_close(win, true)
      end
      if timer then
        timer:close()
      end
    end,
  })
end

local function maybe_show_write_tip(args)
  local now = math.floor((vim.uv or vim.loop).hrtime() / 1000000)
  if now - M.state.last_tip_at < M.config.write_tip_throttle_ms then
    return
  end

  local buf = args and args.buf or vim.api.nvim_get_current_buf()
  if vim.bo[buf].buftype ~= '' then
    return
  end

  if vim.api.nvim_buf_get_name(buf) == '' then
    return
  end

  M.state.last_tip_at = now
  vim.schedule(show_random_tip)
end

local function open_cheatsheet()
  vim.cmd('vsplit ' .. vim.fn.fnameescape(M.config.path))
end

local function edit_cheatsheet()
  vim.cmd('edit ' .. vim.fn.fnameescape(M.config.path))
end

local function search_cheatsheet()
  require('telescope.builtin').live_grep {
    search_dirs = { M.config.path },
    prompt_title = 'Search Cheatsheet',
  }
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})
  local augroup = vim.api.nvim_create_augroup('CustomCheatsheet', { clear = true })

  vim.keymap.set('n', '<leader>cc', open_cheatsheet, { desc = '[C]heatsheet [C]open' })
  vim.keymap.set('n', '<leader>ce', edit_cheatsheet, { desc = '[C]heatsheet [E]dit' })
  vim.keymap.set('n', '<leader>cs', search_cheatsheet, { desc = '[C]heatsheet [S]earch' })
  vim.keymap.set('n', '<leader>ct', show_random_tip, { desc = '[C]heatsheet [T]ip' })

  vim.api.nvim_create_autocmd('VimEnter', {
    group = augroup,
    callback = function()
      if vim.fn.argc() == 0 and vim.api.nvim_buf_get_name(0) == '' then
        vim.defer_fn(show_random_tip, 200)
      end
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePost', {
    group = augroup,
    callback = maybe_show_write_tip,
  })
end

return M
