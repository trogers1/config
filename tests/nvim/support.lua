-- Shared setup for headless Neovim specs, run by tests/nvim-sidecar-comments.test.sh.
-- Each spec loads the real config module from NVIM_CONFIG and drives it against
-- the installed `sidecar` CLI inside a scratch TEST_DIR.
local M = {}

-- Parenthesized: assert also returns its message, which vim.fn.resolve rejects.
M.dir = vim.fn.resolve((assert(vim.env.TEST_DIR, 'TEST_DIR is required')))
vim.opt.rtp:prepend((assert(vim.env.NVIM_CONFIG, 'NVIM_CONFIG is required')))
vim.g.mapleader = ' '
-- Keep "written" messages out of the test output.
vim.opt.shortmess:append 'W'

local passes, failures = 0, 0

function M.check(name, cond, detail)
  if cond then
    passes = passes + 1
    io.stdout:write('PASS ' .. name .. '\n')
  else
    failures = failures + 1
    io.stdout:write('FAIL ' .. name .. (detail ~= nil and (': ' .. vim.inspect(detail)) or '') .. '\n')
  end
end

--- Run the sidecar CLI directly (as an agent would) and return its JSON result.
function M.cli(opts)
  local cmd = { 'sidecar', '--output', 'json' }
  vim.list_extend(cmd, opts.args)
  local completed = vim.system(cmd, { stdin = opts.stdin, text = true }):wait()
  if completed.code ~= 0 then
    error(string.format('sidecar %s exited %d: %s', table.concat(opts.args, ' '), completed.code, completed.stderr))
  end
  return vim.json.decode(completed.stdout).result
end

--- Threads in a sidecar, including retained tracking excerpts.
function M.threads(opts)
  return M.cli({ args = { 'thread', 'list', '--include-tracking', '--file', opts.sidecar } }).threads
end

function M.thread(opts)
  for _, thread in ipairs(M.threads { sidecar = opts.sidecar }) do
    if thread.id == opts.id then
      return thread
    end
  end
  error(string.format('Thread %s is not in %s', opts.id, opts.sidecar))
end

--- Create a thread through the CLI, bypassing the plugin, and return its ID.
function M.create_thread(opts)
  return M.cli({
    args = { 'thread', 'create', '--file', opts.sidecar, '--location', opts.location, '--author-kind', opts.author_kind or 'human', '--body-file', '-' },
    stdin = (opts.body or 'note') .. '\n',
  }).generated_ids.thread_id
end

--- Write a source file with one thread and return its path and thread ID.
function M.source_with_thread(opts)
  local path = M.dir .. '/' .. opts.name
  vim.fn.mkdir(vim.fs.dirname(path), 'p')
  vim.fn.writefile(opts.lines, path)
  return path, M.create_thread { sidecar = path .. '.comments', location = opts.location }
end

function M.finish()
  io.stdout:write(string.format('%d passed, %d failed\n', passes, failures))
  vim.cmd(failures == 0 and 'qa!' or 'cq!')
end

return M
