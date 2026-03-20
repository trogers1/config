local M = {}

M.config = {
  bin = 'opencode',
  run_args = { 'run' },
  agents = {
    plan = 'plan',
    build = 'build',
  },
  model = nil,
  diff_hint = 'If reasonable to suggest diffs, return all diffs in a ```diff``` block. Prefer unified diff with diff --git headers and a/ b/ paths. Apply_patch format is also acceptable. If anything is ambiguous, pick the most reasonable default and state it in one sentence before the diff, then provide the diff.',
}

M.state = {
  last_response = nil,
  last_diff = nil,
  last_prompt = nil,
  last_agent = nil,
}

local function is_visual_mode(mode)
  return mode == 'v' or mode == 'V' or mode == '\22'
end

local function get_selection()
  local mode = vim.fn.mode()
  if not is_visual_mode(mode) then
    local line = vim.api.nvim_win_get_cursor(0)[1]
    local text = vim.api.nvim_buf_get_lines(0, line - 1, line, false)
    return line, line, text
  end

  local start_pos = vim.fn.getpos "'<"
  local end_pos = vim.fn.getpos "'>"
  local start_line = start_pos[2]
  local end_line = end_pos[2]
  if start_line == 0 or end_line == 0 then
    local line = vim.api.nvim_win_get_cursor(0)[1]
    local text = vim.api.nvim_buf_get_lines(0, line - 1, line, false)
    return line, line, text
  end

  if start_line > end_line then
    start_line, end_line = end_line, start_line
  end

  local lines = vim.api.nvim_buf_get_lines(0, start_line - 1, end_line, false)
  return start_line, end_line, lines
end

local function build_prompt(file_path, start_line, end_line, lines, user_prompt, diff_hint)
  local header = string.format('File: %s\nLines: %d-%d\n', file_path, start_line, end_line)
  local body = table.concat(lines, '\n')
  local prompt = header .. '\n' .. body .. '\n\nPrompt:\n' .. user_prompt
  if diff_hint and diff_hint ~= '' then
    prompt = prompt .. '\n\n' .. diff_hint
  end
  return prompt
end

local function extract_diff(text)
  if not text or text == '' then
    return nil
  end

  local diff_block = text:match '```diff\n(.-)\n```'
  if diff_block and diff_block ~= '' then
    return diff_block
  end

  local diff_start = text:find 'diff %-%-git '
  if diff_start then
    return text:sub(diff_start)
  end

  local unified_start = text:find('^%-%-%- ', 1, false)
  if unified_start then
    return text:sub(unified_start)
  end

  return nil
end

local function normalize_diff(diff_text)
  if not diff_text or diff_text == '' then
    return diff_text
  end

  local lines = vim.split(diff_text, '\n', { plain = true })
  local min_indent = nil
  for _, line in ipairs(lines) do
    if line ~= '' then
      local indent = line:match '^(%s*)'
      if indent then
        local len = #indent
        if min_indent == nil or len < min_indent then
          min_indent = len
        end
      end
    end
  end

  if min_indent and min_indent > 0 then
    for idx, line in ipairs(lines) do
      if line ~= '' then
        lines[idx] = line:sub(min_indent + 1)
      end
    end
  end

  local normalized = table.concat(lines, '\n')
  if not normalized:match '\n$' then
    normalized = normalized .. '\n'
  end
  return normalized
end

local function looks_like_apply_patch(diff_text)
  return diff_text:match '^%*%*%* Begin Patch' or diff_text:match '^%*%*%* Update File:'
end

local function looks_like_unified_diff(diff_text)
  if diff_text:match '^diff %-%-git ' then
    return true
  end

  local has_from = diff_text:match '^%-%-%- '
  local has_to = diff_text:match '^%+%+%+ '
  return has_from and has_to
end

local function normalize_path(path)
  if not path or path == '' then
    return path
  end
  return vim.fn.fnamemodify(path, ':p')
end

local function path_for_diff(path)
  if not path or path == '' then
    return path
  end

  if path:sub(1, 1) == '/' then
    local cwd = vim.fn.getcwd()
    if path:sub(1, #cwd) == cwd then
      local rel = path:sub(#cwd + 2)
      if rel ~= '' then
        return rel
      end
    end
  end
  return path
end

local function parse_apply_patch(diff_text)
  if not looks_like_apply_patch(diff_text or '') then
    return nil
  end

  local lines = vim.split(diff_text, '\n', { plain = true })
  local ops = {}
  local idx = 1

  while idx <= #lines do
    local line = lines[idx]
    local add_path = line:match '^%*%*%* Add File: (.+)$'
    local del_path = line:match '^%*%*%* Delete File: (.+)$'
    local upd_path = line:match '^%*%*%* Update File: (.+)$'

    if add_path then
      idx = idx + 1
      local content = {}
      while idx <= #lines and not lines[idx]:match '^%*%*%* ' do
        local add_line = lines[idx]
        if add_line:sub(1, 1) == '+' then
          table.insert(content, add_line:sub(2))
        else
          table.insert(content, add_line)
        end
        idx = idx + 1
      end
      table.insert(ops, { kind = 'add', path = add_path, content = content })
    elseif del_path then
      table.insert(ops, { kind = 'delete', path = del_path })
      idx = idx + 1
    elseif upd_path then
      idx = idx + 1
      local move_to = nil
      if lines[idx] and lines[idx]:match '^%*%*%* Move to: ' then
        move_to = lines[idx]:match '^%*%*%* Move to: (.+)$'
        idx = idx + 1
      end
      local hunk_lines = {}
      while idx <= #lines and not lines[idx]:match '^%*%*%* ' do
        table.insert(hunk_lines, lines[idx])
        idx = idx + 1
      end
      table.insert(ops, {
        kind = 'update',
        path = upd_path,
        move_to = move_to,
        hunk_text = table.concat(hunk_lines, '\n'),
      })
    else
      idx = idx + 1
    end
  end

  return ops
end

local function build_unified_update(path, hunk_text)
  local rel = path_for_diff(path)
  local header = {
    string.format('diff --git a/%s b/%s', rel, rel),
    string.format('--- a/%s', rel),
    string.format('+++ b/%s', rel),
  }
  return table.concat(header, '\n') .. '\n' .. hunk_text
end

local function open_scratch(title)
  vim.cmd 'botright vnew'
  local buf = vim.api.nvim_get_current_buf()
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = true
  vim.bo[buf].filetype = 'markdown'
  if title and title ~= '' then
    vim.api.nvim_buf_set_name(buf, title)
  end
  return buf
end

local function is_opencode_buffer(buf)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    return false
  end
  local name = vim.api.nvim_buf_get_name(buf)
  return name:match '^opencode://' ~= nil
end

local function with_modifiable(buf, fn)
  if not vim.api.nvim_buf_is_valid(buf) then
    return false
  end

  vim.api.nvim_set_option_value('modifiable', true, { buf = buf })
  vim.api.nvim_set_option_value('readonly', false, { buf = buf })
  local ok, err = pcall(fn)
  vim.api.nvim_set_option_value('modifiable', false, { buf = buf })
  return ok, err
end

local function set_buffer_lines(buf, output)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end

  local lines = vim.split(output or '', '\n', { plain = true })
  local ok = with_modifiable(buf, function()
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  end)
  if not ok then
    vim.api.nvim_set_option_value('modifiable', true, { buf = buf })
    vim.api.nvim_set_option_value('readonly', false, { buf = buf })
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.api.nvim_set_option_value('modifiable', false, { buf = buf })
  end
end

local function append_lines(buf, lines)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end

  with_modifiable(buf, function()
    local line_count = vim.api.nvim_buf_line_count(buf)
    vim.api.nvim_buf_set_lines(buf, line_count, line_count, false, lines)
  end)
end

local function append_followup_placeholder(buf, user_prompt)
  local line_count = vim.api.nvim_buf_line_count(buf)
  local lines = {
    '',
    'Prompt:',
    '  ' .. user_prompt,
    '',
    'Response:',
    '  Waiting for opencode response...',
  }
  append_lines(buf, lines)

  local response_start = line_count + 6
  return response_start
end

local function replace_lines(buf, start_line, end_line, lines)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end

  with_modifiable(buf, function()
    vim.api.nvim_buf_set_lines(buf, start_line - 1, end_line, false, lines)
  end)
end

local function attach_apply_map(buf)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end

  vim.keymap.set('n', '<leader>oa', function()
    M.apply_diff_under_cursor()
  end, { buffer = buf, desc = 'Opencode apply diff under cursor' })
end

local function maybe_attach_apply(buf, has_diff)
  if has_diff then
    attach_apply_map(buf)
  end
end

local function show_output(agent, output, existing_buf, has_diff)
  local title = string.format('opencode://%s', agent)
  local buf = existing_buf
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    buf = open_scratch(title)
  else
    vim.api.nvim_buf_set_name(buf, title)
  end

  set_buffer_lines(buf, output)
  maybe_attach_apply(buf, has_diff)
  return buf
end

local function append_output(buf, output, has_diff, response_line)
  local text = output
  if not text or text == '' then
    text = 'No response received.'
  end
  local lines = vim.split(text, '\n', { plain = true })
  replace_lines(buf, response_line, response_line, lines)
  maybe_attach_apply(buf, has_diff)
end

local function show_pending(agent)
  local title = string.format('opencode://%s', agent)
  local buf = open_scratch(title)
  set_buffer_lines(buf, 'Waiting for opencode response...')
  return buf
end

local function show_pending_with_prompt(agent, user_prompt)
  local title = string.format('opencode://%s', agent)
  local buf = open_scratch(title)
  local lines = {
    'Prompt:',
    '  ' .. user_prompt,
    '',
    'Response:',
    '  Waiting for opencode response...',
  }
  set_buffer_lines(buf, table.concat(lines, '\n'))
  return buf, 5
end

local function run_command(cmd, stdin, on_done)
  local function safe_done(code, stdout, stderr)
    vim.schedule(function()
      on_done(code, stdout, stderr)
    end)
  end

  if vim.system then
    vim.system(cmd, { text = true, stdin = stdin }, function(result)
      safe_done(result.code or 0, result.stdout or '', result.stderr or '')
    end)
    return
  end

  local stdout = {}
  local stderr = {}
  local job_id = vim.fn.jobstart(cmd, {
    stdout_buffered = true,
    stderr_buffered = true,
    on_stdout = function(_, data)
      if data then
        stdout = data
      end
    end,
    on_stderr = function(_, data)
      if data then
        stderr = data
      end
    end,
    on_exit = function(_, code)
      safe_done(code, table.concat(stdout, '\n'), table.concat(stderr, '\n'))
    end,
  })

  if job_id <= 0 then
    safe_done(1, '', 'Failed to start opencode command')
    return
  end

  if stdin and stdin ~= '' then
    vim.fn.chansend(job_id, stdin)
  end
  vim.fn.chanclose(job_id, 'stdin')
end

local function guess_patch_strip(diff_text)
  if diff_text:match '^%-%-%- a/' or diff_text:match '^%+%+%+ b/' then
    return 1
  end
  return 0
end

local function try_patch_apply(diff_text, on_done)
  if vim.fn.executable 'patch' ~= 1 then
    vim.notify('patch command not found for fallback apply.', vim.log.levels.ERROR)
    if on_done then
      on_done(false)
    end
    return
  end

  local strip = guess_patch_strip(diff_text)
  local attempts = strip == 1 and { 1, 0 } or { 0, 1 }

  local function attempt(index)
    local p = attempts[index]
    if not p then
      if on_done then
        on_done(false)
      end
      return
    end

    run_command({ 'patch', string.format('-p%d', p), '-N', '-r', '-' }, diff_text, function(code, stdout, stderr)
      if code == 0 then
        vim.notify 'Applied diff with patch fallback.'
        vim.cmd 'checktime'
        if on_done then
          on_done(true)
        end
        return
      end

      attempt(index + 1)
    end)
  end

  attempt(1)
end

local function fallback_patch(normalized, message, on_done)
  vim.notify(message .. ' Trying patch fallback...', vim.log.levels.WARN)
  try_patch_apply(normalized, function(ok)
    if on_done then
      on_done(ok)
    end
    if not ok then
      vim.notify(message, vim.log.levels.ERROR)
    end
  end)
end

local function apply_unified_diff(diff_text, on_done)
  local normalized = normalize_diff(diff_text)
  run_command({ 'git', 'apply', '--check', '--whitespace=nowarn', '-' }, normalized, function(code, stdout, stderr)
    if code == 0 then
      run_command({ 'git', 'apply', '--whitespace=nowarn', '-' }, normalized, function(code_apply, stdout_apply, stderr_apply)
        if code_apply == 0 then
          if on_done then
            on_done(true)
          end
          vim.notify 'Applied diff with git apply.'
          vim.cmd 'checktime'
          return
        end

        local message_apply = stderr_apply ~= '' and stderr_apply or stdout_apply
        if message_apply == '' then
          message_apply = 'git apply failed to apply diff.'
        end
        fallback_patch(normalized, message_apply, on_done)
      end)
      return
    end

    run_command({ 'git', 'apply', '--reverse', '--check', '--whitespace=nowarn', '-' }, normalized, function(code_rev, stdout_rev, stderr_rev)
      if code_rev == 0 then
        vim.notify 'Diff already applied.'
        if on_done then
          on_done(true)
        end
        return
      end

      local message = stderr ~= '' and stderr or stdout
      if message == '' then
        message = 'git apply failed to apply diff.'
      end
      fallback_patch(normalized, message, on_done)
    end)
  end)
end

local function apply_apply_patch(diff_text)
  local ops = parse_apply_patch(diff_text)
  if not ops or #ops == 0 then
    vim.notify('No valid apply_patch operations found.', vim.log.levels.WARN)
    return
  end

  local function apply_next(index)
    if index > #ops then
      vim.notify 'Applied apply_patch operations.'
      vim.cmd 'checktime'
      return
    end

    local op = ops[index]
    if op.kind == 'add' then
      local path = normalize_path(op.path)
      local dir = vim.fn.fnamemodify(path, ':h')
      if dir and dir ~= '' then
        vim.fn.mkdir(dir, 'p')
      end
      local ok, err = pcall(vim.fn.writefile, op.content, path)
      if not ok then
        vim.notify('Failed to write file: ' .. tostring(err), vim.log.levels.ERROR)
        return
      end
      apply_next(index + 1)
    elseif op.kind == 'delete' then
      local path = normalize_path(op.path)
      local result = vim.fn.delete(path)
      if result ~= 0 then
        vim.notify('Failed to delete file: ' .. path, vim.log.levels.ERROR)
        return
      end
      apply_next(index + 1)
    elseif op.kind == 'update' then
      local unified = build_unified_update(op.path, op.hunk_text)
      apply_unified_diff(unified, function(ok)
        if not ok then
          return
        end

        if op.move_to and op.move_to ~= '' then
          local from_path = normalize_path(op.path)
          local to_path = normalize_path(op.move_to)
          local to_dir = vim.fn.fnamemodify(to_path, ':h')
          if to_dir and to_dir ~= '' then
            vim.fn.mkdir(to_dir, 'p')
          end
          local uv = vim.uv or vim.loop
          local ok_rename = uv.fs_rename(from_path, to_path)
          if not ok_rename then
            vim.notify('Failed to move file to: ' .. to_path, vim.log.levels.ERROR)
            return
          end
        end

        apply_next(index + 1)
      end)
    else
      apply_next(index + 1)
    end
  end

  apply_next(1)
end

local function apply_diff(diff_text)
  if not diff_text or diff_text == '' then
    vim.notify('No diff available to apply.', vim.log.levels.WARN)
    return
  end

  local normalized = normalize_diff(diff_text)
  if looks_like_apply_patch(normalized) then
    apply_apply_patch(normalized)
    return
  end

  if not looks_like_unified_diff(normalized) then
    vim.notify('Diff is not a valid diff. Ask for unified diff or apply_patch format.', vim.log.levels.WARN)
    return
  end

  apply_unified_diff(normalized)
end

local function collect_diff_blocks(lines)
  local blocks = {}
  local idx = 1
  while idx <= #lines do
    if lines[idx]:match '^```diff%s*$' then
      local start_line = idx
      local content = {}
      idx = idx + 1
      while idx <= #lines and not lines[idx]:match '^```%s*$' do
        table.insert(content, lines[idx])
        idx = idx + 1
      end
      local end_line = idx
      table.insert(blocks, {
        start_line = start_line,
        end_line = end_line,
        content = normalize_diff(table.concat(content, '\n')),
      })
    end
    idx = idx + 1
  end
  return blocks
end

function M.apply_last_diff()
  if not M.state.last_diff then
    vim.notify('No diff available to apply.', vim.log.levels.WARN)
    return
  end

  local confirm = vim.fn.confirm('Apply last opencode diff?', '&Yes\n&No', 2)
  if confirm ~= 1 then
    return
  end

  apply_diff(M.state.last_diff)
end

function M.apply_diff_under_cursor()
  local buf = vim.api.nvim_get_current_buf()
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local blocks = collect_diff_blocks(lines)
  local cursor_line = vim.api.nvim_win_get_cursor(0)[1]

  for _, block in ipairs(blocks) do
    if cursor_line >= block.start_line and cursor_line <= block.end_line then
      if block.content == '' then
        vim.notify('Diff block is empty.', vim.log.levels.WARN)
        return
      end

      local confirm = vim.fn.confirm('Apply diff under cursor?', '&Yes\n&No', 2)
      if confirm ~= 1 then
        return
      end

      M.state.last_diff = block.content
      apply_diff(block.content)
      return
    end
  end

  vim.notify('No diff block under cursor. Place cursor inside a ```diff``` block.', vim.log.levels.WARN)
end

local function build_followup_prompt(user_prompt)
  local previous = M.state.last_response or ''
  local prompt = 'Previous response:\n' .. previous .. '\n\nFollow-up:\n' .. user_prompt
  if M.config.diff_hint and M.config.diff_hint ~= '' then
    prompt = prompt .. '\n\n' .. M.config.diff_hint
  end
  return prompt
end

local function build_cmd(agent)
  local cmd = { M.config.bin }
  vim.list_extend(cmd, M.config.run_args)
  vim.list_extend(cmd, { '--agent', M.config.agents[agent] or agent })
  if M.config.model and M.config.model ~= '' then
    vim.list_extend(cmd, { '--model', M.config.model })
  end
  return cmd
end

local function parse_response(code, stdout, stderr)
  if code ~= 0 then
    local message = stderr ~= '' and stderr or ('opencode failed with code ' .. tostring(code))
    return nil, message, vim.log.levels.ERROR
  end

  if stdout == '' then
    local message = stderr ~= '' and stderr or 'No response received.'
    return nil, message, vim.log.levels.WARN
  end

  return stdout, nil, nil
end

function M.run_followup(agent)
  local buf = vim.api.nvim_get_current_buf()
  if not is_opencode_buffer(buf) then
    vim.notify('Not in an opencode scratch buffer.', vim.log.levels.WARN)
    return
  end

  vim.ui.input({ prompt = 'opencode follow-up: ' }, function(user_prompt)
    if not user_prompt or user_prompt == '' then
      return
    end

    local prompt = build_followup_prompt(user_prompt)
    local cmd = build_cmd(agent)

    local response_line = append_followup_placeholder(buf, user_prompt)

    run_command(cmd, prompt, function(code, stdout, stderr)
      local output, message, level = parse_response(code, stdout, stderr)
      if not output then
        if message then
          vim.notify(message, level)
        end
        append_output(buf, message or '', false, response_line)
        return
      end

      M.state.last_response = output
      M.state.last_diff = normalize_diff(extract_diff(output))
      M.state.last_prompt = prompt
      M.state.last_agent = agent
      append_output(buf, output, M.state.last_diff ~= nil, response_line)
    end)
  end)
end

function M.run(agent)
  local file_path = vim.api.nvim_buf_get_name(0)
  if file_path == '' then
    file_path = '[No Name]'
  end

  local start_line, end_line, lines = get_selection()
  vim.ui.input({ prompt = 'opencode prompt: ' }, function(user_prompt)
    if not user_prompt or user_prompt == '' then
      return
    end

    local prompt = build_prompt(file_path, start_line, end_line, lines, user_prompt, M.config.diff_hint)
    M.state.last_prompt = prompt
    M.state.last_agent = agent

    local cmd = build_cmd(agent)

    local pending_buf, response_line = show_pending_with_prompt(agent, user_prompt)

    run_command(cmd, prompt, function(code, stdout, stderr)
      local output, message, level = parse_response(code, stdout, stderr)
      if not output then
        if message then
          vim.notify(message, level)
        end
        append_output(pending_buf, message or '', false, response_line)
        return
      end

      M.state.last_response = output
      M.state.last_diff = normalize_diff(extract_diff(output))
      append_output(pending_buf, output, M.state.last_diff ~= nil, response_line)
    end)
  end)
end

function M.is_opencode_buffer(buf)
  return is_opencode_buffer(buf)
end

function M.setup(opts)
  if opts then
    M.config = vim.tbl_deep_extend('force', M.config, opts)
  end
end

return M
