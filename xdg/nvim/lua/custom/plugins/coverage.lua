-- Inline test-coverage markers. A TypeScript/JavaScript buffer automatically
-- loads the nearest coverage/lcov.info report; `auto_reload` refreshes markers
-- after Vitest rewrites it.
--
-- Report recipes supported by nvim-coverage:
--   TypeScript/JavaScript (default):
--     npm exec vitest run -- --coverage --coverage.reporter=lcov
--     (install `@vitest/coverage-v8`; this writes coverage/lcov.info.)
--   Go:     go test ./... -coverprofile=coverage.out
--   Python: coverage json  (after `coverage run -m pytest`)
--   Lua:    luacov  (writes luacov.report.out)
-- Other tools can be used too if they produce an LCOV report. See
-- `:help nvim-coverage` for the supported formats and per-language paths.
return {
  {
    'andythigpen/nvim-coverage',
    dependencies = { 'nvim-lua/plenary.nvim' },
    event = { 'BufReadPost', 'BufNewFile' },
    cmd = {
      'Coverage',
      'CoverageClear',
      'CoverageHide',
      'CoverageLoad',
      'CoverageShow',
      'CoverageSummary',
      'CoverageToggle',
    },
    keys = {
      { '<leader>tc', '<cmd>Coverage<cr>', desc = 'Test: load coverage' },
      { '<leader>tC', '<cmd>CoverageClear<cr>', desc = 'Test: clear coverage' },
      { '<leader>ts', '<cmd>CoverageSummary<cr>', desc = 'Test: coverage summary' },
    },
    opts = {
      auto_reload = true,
      lang = {
        -- Typescript delegates to the JavaScript parser, so one setting covers
        -- .js/.jsx/.ts/.tsx (and Vue) buffers.
        javascript = {
          coverage_file = function()
            local filename = vim.api.nvim_buf_get_name(0)
            if filename ~= '' then
              for directory in vim.fs.parents(vim.fs.dirname(filename)) do
                local report = directory .. '/coverage/lcov.info'
                if vim.uv.fs_stat(report) then return report end
              end
            end

            -- Preserve nvim-coverage's default for manual `:Coverage` use.
            return vim.fn.getcwd() .. '/coverage/lcov.info'
          end,
        },
      },
    },
    config = function(_, opts)
      require('coverage').setup(opts)

      local coverage_filetypes = {
        javascript = true,
        javascriptreact = true,
        typescript = true,
        typescriptreact = true,
        vue = true,
      }
      local loaded_report
      local function load_nearest_report()
        if not coverage_filetypes[vim.bo.filetype] then return end

        local filename = vim.api.nvim_buf_get_name(0)
        if filename == '' then return end
        for directory in vim.fs.parents(vim.fs.dirname(filename)) do
          local report = directory .. '/coverage/lcov.info'
          if vim.uv.fs_stat(report) then
            if report ~= loaded_report then
              loaded_report = report
              require('coverage').load(true)
            end
            return
          end
        end
      end

      vim.api.nvim_create_autocmd('BufEnter', {
        group = vim.api.nvim_create_augroup('coverage-auto-load', { clear = true }),
        callback = load_nearest_report,
      })
      -- The plugin is loaded during BufReadPost, before the first BufEnter.
      vim.schedule(load_nearest_report)
    end,
  },
}
