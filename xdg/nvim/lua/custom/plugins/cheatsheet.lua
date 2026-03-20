-- Custom cheatsheet functionality
return {
  -- This creates a "virtual" plugin that just sets up keymaps
  {
    'cheatsheet',
    dir = vim.fn.stdpath 'config', -- Use config directory as plugin source
    name = 'cheatsheet',
    config = function()
      -- Path to the cheatsheet file
      local cheatsheet_path = vim.fn.stdpath 'config' .. '/vim_cheatsheet.md'

      -- Helper function to trim whitespace
      local function trim(s)
        return s:match '^%s*(.-)%s*$'
      end

      -- Function to extract tips from cheatsheet file
      local function extract_tips()
        local tips = {}
        local file = io.open(cheatsheet_path, 'r')

        if not file then
          -- Fallback tips if file can't be read
          return {
            '💡 Use `<C-o>` and `<C-i>` to navigate your jumplist',
            '🔍 Press `<C-q>` in Telescope to add results to quickfix list',
            '⚡ Record macros with `q<letter>` and replay with `@<letter>`',
          }
        end

        local current_section = ''
        local in_pro_tips = false

        for line in file:lines() do
          -- Track current section for context
          local section = line:match '^## (.+)'
          if section then
            current_section = section:gsub('[🔧📝🔍🔭📁🛠️🎯💡]', '')
            current_section = trim(current_section)
            in_pro_tips = current_section:find 'Pro Tips' ~= nil
          end

          -- Extract table rows (command | description format)
          local command, description = line:match '^| (`[^`]+`) | (.+) |$'
          if command and description then
            -- Clean up description (remove markdown formatting)
            description = description:gsub('%*%*(.-)%*%*', '%1') -- Remove bold
            description = description:gsub('_%*(.-)%*_', '%1') -- Remove italic
            description = description:gsub('%[(.-)%]', '%1') -- Remove links
            description = trim(description)

            -- Create a nice tip format
            local tip = string.format('Use %s to %s', command, description:lower())
            table.insert(tips, tip)
          end

          -- Extract Pro Tips section items (numbered list)
          if in_pro_tips then
            local pro_tip = line:match '^%d+%. %*%*(.-)%*%*: (.+)'
            if pro_tip then
              local tip_text = string.format('💡 %s: %s', pro_tip, pro_tip_desc)
              table.insert(tips, tip_text)
            else
              -- Extract simple numbered list items from Pro Tips
              local simple_tip = line:match '^%d+%. (.+)'
              if simple_tip then
                table.insert(tips, '💡 ' .. simple_tip)
              end
            end
          end
        end

        file:close()

        -- If no tips found, return fallback
        if #tips == 0 then
          return {
            '💡 Use `<C-o>` and `<C-i>` to navigate your jumplist',
            '🔍 Press `<C-q>` in Telescope to add results to quickfix list',
            '⚡ Record macros with `q<letter>` and replay with `@<letter>`',
          }
        end

        return tips
      end

      -- Function to show random tip in a pretty popup
      local function show_random_tip()
        local tips = extract_tips()
        math.randomseed(os.time())
        local tip = tips[math.random(#tips)]

        -- Create a floating window for the tip
        local width = math.min(80, vim.o.columns - 4)
        local height = 6
        local buf = vim.api.nvim_create_buf(false, true)

        -- Calculate center position
        local ui = vim.api.nvim_list_uis()[1]
        local win_width = ui.width
        local win_height = ui.height
        local row = math.ceil((win_height - height) / 2)
        local col = math.ceil((win_width - width) / 2)

        -- Window options
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

        -- Create the window
        local win = vim.api.nvim_open_win(buf, false, opts)

        -- Wrap long tips
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

        -- Add content to buffer
        local content_lines = { '', '  ' .. wrapped_tip, '', '  Press any key to dismiss...', '' }

        -- Handle multi-line tips
        if wrapped_tip:find '\n' then
          content_lines = { '' }
          for line in wrapped_tip:gmatch '[^\n]+' do
            table.insert(content_lines, '  ' .. line)
          end
          table.insert(content_lines, '')
          table.insert(content_lines, '  Press any key to dismiss...')
          table.insert(content_lines, '')

          -- Adjust window height for multi-line tips
          height = #content_lines + 2
          opts.height = height
          opts.row = math.ceil((win_height - height) / 2)
          vim.api.nvim_win_close(win, true)
          win = vim.api.nvim_open_win(buf, false, opts)
        end

        vim.api.nvim_buf_set_lines(buf, 0, -1, false, content_lines)

        -- Set buffer options
        vim.api.nvim_buf_set_option(buf, 'modifiable', false)
        vim.api.nvim_buf_set_option(buf, 'bufhidden', 'wipe')

        -- Set window highlights
        vim.api.nvim_win_set_option(win, 'winhl', 'Normal:Normal,FloatBorder:FloatBorder')

        -- Auto-close after 8 seconds or on any key press
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

        -- Close on any key press
        vim.keymap.set('n', '<Esc>', function()
          if vim.api.nvim_win_is_valid(win) then
            vim.api.nvim_win_close(win, true)
          end
          if timer then
            timer:close()
          end
        end, { buffer = buf, silent = true })

        -- Close on cursor movement or buffer leave
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

      -- Quick open cheatsheet in a split
      local function open_cheatsheet()
        vim.cmd('vsplit ' .. cheatsheet_path)
      end

      -- Quick open cheatsheet in current buffer
      local function edit_cheatsheet()
        vim.cmd('edit ' .. cheatsheet_path)
      end

      -- Search through cheatsheet with Telescope
      local function search_cheatsheet()
        require('telescope.builtin').live_grep {
          search_dirs = { cheatsheet_path },
          prompt_title = 'Search Cheatsheet',
        }
      end

      -- Setup keymaps
      vim.keymap.set('n', '<leader>cc', open_cheatsheet, { desc = '[C]heatsheet [C]open' })
      vim.keymap.set('n', '<leader>ce', edit_cheatsheet, { desc = '[C]heatsheet [E]dit' })
      vim.keymap.set('n', '<leader>cs', search_cheatsheet, { desc = '[C]heatsheet [S]earch' })
      vim.keymap.set('n', '<leader>ct', show_random_tip, { desc = '[C]heatsheet [T]ip' })

      -- Show random tip on startup (with a small delay to let Neovim fully load)
      vim.api.nvim_create_autocmd('VimEnter', {
        callback = function()
          -- Only show tip if no files were opened (empty buffer)
          if vim.fn.argc() == 0 and vim.api.nvim_buf_get_name(0) == '' then
            vim.defer_fn(show_random_tip, 200) -- 200ms delay
          end
        end,
      })
    end,
  },
}
