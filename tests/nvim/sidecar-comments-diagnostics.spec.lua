-- Exercise the CLI boundary with future error envelopes; successful requests
-- still use the installed CLI and its real sidecar format.
local t = dofile(vim.fs.joinpath(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2)), 'support.lua'))
local sc = require 'custom.sidecar_comments'
local cli = vim.fn.exepath 'sidecar'
local wrapper = t.dir .. '/sidecar-test'
vim.fn.writefile({
  '#!/bin/sh',
  'if [ "$3" = "fix" ] && [ -n "$SIDECAR_TEST_FIX_ERROR" ]; then',
  '  printf "%s\\n" "$SIDECAR_TEST_FIX_ERROR" >&2',
  '  exit 1',
  'fi',
  'if [ -n "$SIDECAR_TEST_ERROR" ]; then',
  '  printf "%s\\n" "$SIDECAR_TEST_ERROR" >&2',
  '  exit 1',
  'fi',
  'exec ' .. vim.fn.shellescape(cli) .. ' "$@"',
}, wrapper)
vim.fn.setfperm(wrapper, 'rwx------')
sc.setup { cmd = wrapper }
vim.notify = function() end

local path, thread_id = t.source_with_thread { name = 'diagnostics.md', lines = { 'source' }, location = 'line:1' }
vim.cmd('edit ' .. path)
local source_buf = vim.api.nvim_get_current_buf()
local sidecar = path .. '.comments'
local original = vim.fn.readfile(sidecar)

local function reject(opts)
  vim.env.SIDECAR_TEST_ERROR = vim.json.encode {
    protocol = sc.protocol,
    error = { code = 'validation', message = 'validation:target_content:invalid', details = {
      path = 'target_content', reason = 'invalid', diagnostics = opts.diagnostics,
    } },
  }
end
local function diagnostics()
  return vim.diagnostic.get(vim.fn.bufnr(sidecar), { namespace = sc.diagnostic_ns_id })
end

reject { diagnostics = {
  { code = 'bad_metadata', message = 'Invalid metadata', hint = 'Use valid JSON', line = 2, column = 4, byte_offset = 12 },
  { code = 'bad_location', message = 'Invalid location', hint = 'Use a line number', line = 3, column = 2, byte_offset = 20 },
} }
vim.cmd('edit ' .. sidecar)
local found = diagnostics()
t.check('read renders every CLI diagnostic', #found == 2, found)
t.check('byte coordinates become zero based without character conversion', found[1].lnum == 1 and found[1].col == 3 and found[2].lnum == 2 and found[2].col == 1, found)
t.check('diagnostic includes code, message, hint and original offset', found[1].code == 'bad_metadata' and found[1].message == 'Invalid metadata\nUse valid JSON' and found[1].user_data.byte_offset == 12, found)
t.check('errors belong only to sidecar', #vim.diagnostic.get(source_buf, { namespace = sc.diagnostic_ns_id }) == 0)

-- Save malformed text: fix errors must survive, rather than being replaced by
-- a second thread-list request (which can have a different error response).
vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'malformed', 'é invalid' })
reject { diagnostics = { { code = 'bad_save', message = 'Saved malformed metadata', hint = 'Correct the saved metadata', line = 2, column = 4, byte_offset = 14 } } }
vim.env.SIDECAR_TEST_FIX_ERROR = vim.env.SIDECAR_TEST_ERROR
vim.env.SIDECAR_TEST_ERROR = nil
local ok, err = pcall(vim.cmd, 'write')
vim.env.SIDECAR_TEST_FIX_ERROR = nil
found = diagnostics()
t.check('malformed save does not throw', ok, err)
t.check('save displays fix diagnostics at byte column', #found == 1 and found[1].code == 'bad_save' and found[1].col == 3, found)

vim.env.SIDECAR_TEST_ERROR = vim.json.encode {
  protocol = sc.protocol,
  error = { code = 'repair', message = 'repair:document', details = { diagnostics = {
    { code = 'missing_message_id', line = 2, byte_offset = 11, thread_id = thread_id, message_ordinal = 2 },
    { code = 'missing_message_id', line = 1, byte_offset = 1, thread_id = thread_id, message_ordinal = 1 },
  } } },
}
vim.cmd 'write'
found = diagnostics()
t.check('legacy repair diagnostics without message hint or column work', #found == 2 and found[1].col == 0 and found[1].message:find('repair:document', 1, true) ~= nil, found)

reject {}
vim.cmd 'write'
found = diagnostics()
t.check('legacy errors without diagnostics retain fallback', #found == 1 and found[1].lnum == 0 and found[1].message:find('validate', 1, true) ~= nil, found)

vim.env.SIDECAR_TEST_ERROR = nil
vim.api.nvim_buf_set_lines(0, 0, -1, false, original)
vim.cmd 'write'
t.check('successful save clears stale errors', #diagnostics() == 0, diagnostics())

reject { diagnostics = { { code = 'read_error', message = 'Read error', hint = 'Correct the sidecar content', line = 1, column = 1, byte_offset = 1 } } }
vim.cmd 'edit!'
t.check('malformed reload displays error', #diagnostics() == 1, diagnostics())
vim.env.SIDECAR_TEST_ERROR = nil
vim.cmd 'edit!'
t.check('successful reread clears stale errors', #diagnostics() == 0, diagnostics())

-- Revalidation originating in the source still targets the sidecar, and
-- clears only stale errors, leaving unresolved-comment warnings alone.
reject { diagnostics = { { code = 'source_read_error', message = 'Invalid sidecar', hint = 'Correct the sidecar content', line = 1, column = 1, byte_offset = 1 } } }
vim.cmd('edit ' .. path)
vim.api.nvim_exec_autocmds('FocusGained', {})
t.check('source refresh publishes errors in loaded sidecar', #diagnostics() == 1, diagnostics())
t.check('source refresh never attaches sidecar errors to source', #vim.diagnostic.get(source_buf, { namespace = sc.diagnostic_ns_id }) == 0)
vim.env.SIDECAR_TEST_ERROR = nil
vim.api.nvim_exec_autocmds('FocusGained', {})
t.check('successful source revalidation clears stale sidecar errors', #diagnostics() == 0, diagnostics())

-- A source-validation failure remains visible at the command boundary, but
-- must not invent a sidecar error or overwrite diagnostics already displayed.
local add_comment = vim.fn.maparg('<Space>sa', 'n', false, true).callback
for _, details in ipairs {
  { path = 'source_coordinate', reason = 'location' },
  { path = 'source_encoding', reason = 'utf8' },
} do
  local message = 'validation:' .. details.path .. ':' .. details.reason
  vim.env.SIDECAR_TEST_ERROR = vim.json.encode {
    protocol = sc.protocol,
    error = { code = 'validation', message = message, details = details },
  }
  local accepted, failure = pcall(add_comment)
  t.check(details.path .. ' command failure stays visible', not accepted and type(failure) == 'string' and failure:find(message, 1, true) ~= nil, failure)
  t.check(details.path .. ' adds no sidecar error', #diagnostics() == 0, diagnostics())

  local side_buf = vim.fn.bufnr(sidecar)
  vim.diagnostic.set(sc.diagnostic_ns_id, side_buf, {
    { lnum = 0, col = 0, severity = vim.diagnostic.severity.WARN, source = 'sidecar', message = 'Existing unresolved comment' },
    { lnum = 1, col = 0, severity = vim.diagnostic.severity.ERROR, source = 'sidecar', message = 'Existing content error' },
  })
  local before = diagnostics()
  accepted, failure = pcall(add_comment)
  t.check(details.path .. ' preserves existing diagnostics', not accepted and vim.deep_equal(before, diagnostics()), { failure, diagnostics() })
  vim.diagnostic.reset(sc.diagnostic_ns_id, side_buf)
end
vim.env.SIDECAR_TEST_ERROR = nil

t.finish()
