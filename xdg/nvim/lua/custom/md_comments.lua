local M = {}

M.config = {
  sidecar_ext = '.comments',
  comment_pattern = '^%[(%d+)%-?(%d*)%]%s*(.*)$',
  highlight_group = 'CommentLineNr',
  sign_priority = 10,
}

M.ns_id = vim.api.nvim_create_namespace 'md_comments'

function M.parse_sidecar(filepath)
  local comments = {}
  local file = io.open(filepath, 'r')
  if not file then
    return comments
  end

  local current_comment = nil
  for line in file:lines() do
    local start_line, end_line, text = line:match(M.config.comment_pattern)
    if start_line then
      if current_comment then
        table.insert(comments, current_comment)
      end

      current_comment = {
        start_line = tonumber(start_line),
        end_line = end_line ~= '' and tonumber(end_line) or tonumber(start_line),
        text = text,
      }
    elseif current_comment then
      current_comment.text = current_comment.text .. '\n' .. line
    end
  end

  if current_comment then
    table.insert(comments, current_comment)
  end

  file:close()
  return comments
end

function M.get_sidecar_path(md_filepath)
  return md_filepath .. M.config.sidecar_ext
end

function M.get_md_path(sidecar_filepath)
  return sidecar_filepath:gsub(vim.pesc(M.config.sidecar_ext) .. '$', '')
end

function M.format_comment(start_line, end_line, text)
  local range = start_line == end_line and tostring(start_line) or string.format('%d-%d', start_line, end_line)
  return string.format('[%s] %s', range, text)
end

function M.open_sidecar(md_filepath, opts)
  opts = opts or {}
  local sidecar_path = M.get_sidecar_path(md_filepath)
  local sidecar_buf = nil

  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(buf) == sidecar_path then
      sidecar_buf = buf
      break
    end
  end

  if sidecar_buf then
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(win) == sidecar_buf then
        vim.api.nvim_set_current_win(win)
        return sidecar_path
      end
    end
  end

  local file = io.open(sidecar_path, 'a')

  if file then
    file:close()
  end

  if sidecar_buf then
    vim.cmd(string.format('%s', opts.vsplit and 'vsplit' or 'split'))
    vim.api.nvim_win_set_buf(0, sidecar_buf)
  else
    vim.cmd(string.format('%s %s', opts.vsplit and 'vsplit' or 'split', vim.fn.fnameescape(sidecar_path)))
  end

  vim.bo.filetype = 'markdown'

  return sidecar_path
end

function M.jump_to_md_line()
  local line = vim.api.nvim_get_current_line()
  local start_line = line:match(M.config.comment_pattern)

  if not start_line then
    return
  end

  local current_file = vim.api.nvim_buf_get_name(0)
  local md_path = M.get_md_path(current_file)
  local md_buf = nil

  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(buf) == md_path then
      md_buf = buf
      break
    end
  end

  if md_buf then
    for _, win in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(win) == md_buf then
        vim.api.nvim_set_current_win(win)
        vim.api.nvim_win_set_cursor(0, { tonumber(start_line), 0 })
        return
      end
    end
  end

  vim.cmd('edit ' .. vim.fn.fnameescape(md_path))
  vim.api.nvim_win_set_cursor(0, { tonumber(start_line), 0 })
end

function M.jump_to_comment()
  local md_path = vim.api.nvim_buf_get_name(0)
  local sidecar_path = M.get_sidecar_path(md_path)

  if vim.fn.filereadable(sidecar_path) == 0 then
    vim.notify('No comments file found', vim.log.levels.INFO)
    return
  end

  local current_line = vim.api.nvim_win_get_cursor(0)[1]
  local comments = M.parse_sidecar(sidecar_path)

  for i, comment in ipairs(comments) do
    if current_line >= comment.start_line and current_line <= comment.end_line then
      local sidecar_buf = nil

      for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_get_name(buf) == sidecar_path then
          sidecar_buf = buf
          break
        end
      end

      if not sidecar_buf then
        M.open_sidecar(md_path, { vsplit = true })
        sidecar_buf = vim.api.nvim_get_current_buf()
      else
        for _, win in ipairs(vim.api.nvim_list_wins()) do
          if vim.api.nvim_win_get_buf(win) == sidecar_buf then
            vim.api.nvim_set_current_win(win)
            break
          end
        end
      end

      local target_line = 0
      local file = io.open(sidecar_path, 'r')
      if file then
        local line_count = 0
        local comment_count = 0
        for file_line in file:lines() do
          line_count = line_count + 1
          if file_line:match(M.config.comment_pattern) then
            comment_count = comment_count + 1
            if comment_count == i then
              target_line = line_count
              break
            end
          end
        end
        file:close()
      end

      if target_line > 0 then
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
  local start_line = vim.fn.line 'v'
  local end_line = vim.api.nvim_win_get_cursor(0)[1]

  if start_line == 0 or end_line == 0 then
    vim.notify('No visual selection found', vim.log.levels.WARN)
    return
  end

  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<Esc>', true, false, true), 'n', false)
  return M.add_comment_for_range(start_line, end_line)
end

function M.add_comment_for_range(start_line, end_line)
  local md_path = vim.api.nvim_buf_get_name(0)

  M.open_sidecar(md_path, { vsplit = true })
  vim.cmd 'normal! G'

  local range = start_line == end_line and tostring(start_line) or string.format('%d-%d', start_line, end_line)
  local new_line = string.format('[%s] ', range)
  vim.api.nvim_put({ new_line }, 'l', true, true)
  vim.cmd 'startinsert!'
end

function M.setup_highlighting(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()
  local filepath = vim.api.nvim_buf_get_name(bufnr)

  if not filepath:match '%.md$' then
    return
  end

  local sidecar_path = M.get_sidecar_path(filepath)
  vim.api.nvim_buf_clear_namespace(bufnr, M.ns_id, 0, -1)

  if vim.fn.filereadable(sidecar_path) == 0 then
    return
  end

  for _, comment in ipairs(M.parse_sidecar(sidecar_path)) do
    for line_num = comment.start_line, comment.end_line do
      vim.api.nvim_buf_set_extmark(bufnr, M.ns_id, line_num - 1, 0, {
        number_hl_group = M.config.highlight_group,
        line_hl_group = 'Visual',
        priority = M.config.sign_priority,
      })
    end
  end
end

function M.setup_autocommands()
  local augroup = vim.api.nvim_create_augroup('MdComments', { clear = true })

  vim.api.nvim_create_autocmd({ 'BufRead', 'BufWritePost' }, {
    group = augroup,
    pattern = '*.md',
    callback = function(args)
      M.setup_highlighting(args.buf)
    end,
  })

  vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
    group = augroup,
    pattern = '*' .. M.config.sidecar_ext,
    callback = function(args)
      vim.bo[args.buf].filetype = 'markdown'
      vim.keymap.set('n', '<CR>', M.jump_to_md_line, { buffer = args.buf, desc = 'Jump to markdown line' })
    end,
  })

  vim.api.nvim_create_autocmd('BufWritePost', {
    group = augroup,
    pattern = '*' .. M.config.sidecar_ext,
    callback = function(args)
      local md_path = M.get_md_path(vim.api.nvim_buf_get_name(args.buf))
      for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_get_name(buf) == md_path then
          M.setup_highlighting(buf)
          break
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

  M.setup_autocommands()

  vim.keymap.set('n', '<leader>mc', function()
    M.open_sidecar(vim.api.nvim_buf_get_name(0), { vsplit = true })
  end, { desc = '[M]arkdown [C]omments open' })

  vim.keymap.set('n', '<leader>mv', M.jump_to_comment, { desc = '[M]arkdown [V]iew comment' })
  vim.keymap.set('n', '<leader>ma', M.add_comment, { desc = '[M]arkdown [A]dd comment' })
  vim.keymap.set('x', '<leader>ma', M.add_comment_for_visual_selection, { desc = '[M]arkdown [A]dd comment for selection' })
end

return M
