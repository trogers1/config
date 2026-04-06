local M = {}

local ns = vim.api.nvim_create_namespace 'markdown_tk_diagnostics'
local tk_regex = vim.regex [[\<\(TK\|tk\)\>]]

local function is_markdown_buffer(bufnr)
  if not vim.api.nvim_buf_is_valid(bufnr) then
    return false
  end

  if vim.bo[bufnr].buftype ~= '' then
    return false
  end

  return vim.api.nvim_buf_get_name(bufnr):match '%.md$' ~= nil
end

function M.refresh(bufnr)
  bufnr = bufnr or vim.api.nvim_get_current_buf()

  if not is_markdown_buffer(bufnr) then
    vim.diagnostic.reset(ns, bufnr)
    return
  end

  local diagnostics = {}
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)

  for lnum, line in ipairs(lines) do
    local offset = 0

    while offset <= #line do
      local start_col, end_col = tk_regex:match_str(line:sub(offset + 1))
      if not start_col or not end_col then
        break
      end

      start_col = start_col + offset
      end_col = end_col + offset

      table.insert(diagnostics, {
        lnum = lnum - 1,
        col = start_col,
        end_lnum = lnum - 1,
        end_col = end_col,
        severity = vim.diagnostic.severity.ERROR,
        source = 'markdown-tk',
        message = 'Address placeholder TK',
      })

      offset = math.max(end_col, offset + 1)
    end
  end

  vim.diagnostic.set(ns, bufnr, diagnostics)
end

function M.setup()
  vim.api.nvim_set_hl(0, 'DiagnosticUnderlineError', {
    undercurl = true,
    sp = '#ef4444',
  })

  local group = vim.api.nvim_create_augroup('MarkdownTkDiagnostics', { clear = true })

  vim.api.nvim_create_autocmd({ 'BufEnter', 'BufReadPost', 'InsertLeave', 'TextChanged', 'BufWritePost' }, {
    group = group,
    pattern = '*.md',
    callback = function(args)
      M.refresh(args.buf)
    end,
  })
end

return M
