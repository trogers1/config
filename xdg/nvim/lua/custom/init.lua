local M = {}

function M.setup()
  require('custom.md_comments').setup()
  require('custom.markdown_tk_diagnostics').setup()
  require('custom.writing_stats').setup()
end

return M
