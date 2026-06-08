" JSONC permits trailing commas in this config, so don't highlight them as syntax
" errors. This is separate from LSP diagnostics; it only affects syntax highlighting.
silent! syntax clear jsonTrailingCommaError
