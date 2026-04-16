# 🚀 Neovim Cheatsheet

> **Legend:**
> - `<Leader>` = `Space`
> - `<C-o>` = `Ctrl+o`
> - `<M-q>` = `Alt+q` (Meta key)
> - `<CR>` = `Enter/Return`

---

## 📝 Basic Editing

### Text Objects & Motions
| Command | Description |
|---------|-------------|
| `ci"` `ci'` `ci)` | **C**hange **i**nside quotes/parentheses |
| `f<char>` | **F**ind next character on line |
| `F<char>` | **F**ind previous character on line |
| `%` | Jump to matching paren/bracket/brace |
| `<num>G` | Go to specific line number |
| `I` | Insert from start of line (first char) |
| `A` | Append from end of line (last char) |

### Copy, Cut, Paste
| Command | Description |
|---------|-------------|
| `yy` | Yank (copy) entire line |
| `P` | Put (paste) above current line |
| `p` | Put (paste) below current line |
| `J` | Join next line to current line |
| `:%s/<FIND_PATTERN>/<REPLACE_PATTERN>` | Find-replace a string in the file (append `/g` to replace multiple instances on the same line, rather than just the first) |
| `:%s/<FIND_PATTERN>\C/<REPLACE_PATTERN>` | Add `\C` to make the find pattern case-sensitive |

### Macros
| Command | Description |
|---------|-------------|
| `q<letter>` | Start recording macro |
| `q` | Stop recording macro |
| `@<letter>` | Play recorded macro |
| `<C-a` | Increment a number under the cursor 🤯 |

---

## 🔍 Navigation & Search

### Buffer Navigation
| Command | Description |
|---------|-------------|
| `gd` | **G**o to **d**efinition |
| `gf` | **G**o to **f**ile (under cursor) |
| `<C-o>` | Jump backward in jumplist |
| `<C-i>` | Jump forward in jumplist |
| `<C-^>` | Switch to previous buffer |
| `:jumps` | View entire jumplist |
| `<Leader-a>` | Toggle Aerial (file tree/navigator) |

### Scrolling
| Command | Description |
|---------|-------------|
| `<C-d>` | Scroll **d**own half page |
| `<C-u>` | Scroll **u**p half page |
| `<S-Down>` | Scroll down half page (alternative) |

### Spell Check
| Command | Description |
|---------|-------------|
| `z=` | Show spelling alternatives for word under cursor |

---

## 🔧 LSP (Language Server Protocol)

| Command | Description |
|---------|-------------|
| `<Leader>rn` | **R**e**n**ame symbol everywhere |
| `<Leader>fm` | **F**or**m**at current buffer |
| `<Leader>ge` | Show diagnostic **e**rror popup |
| `K` | Show hover information/type definition |
| `:LspInfo` | Get LSP server information |
| `:LspLog` | View LSP logs for debugging |

---

## 🔭 Telescope (Fuzzy Finder)

### File Finding
| Command | Description |
|---------|-------------|
| `<Leader>sf` | **S**earch **f**iles (includes hidden) |
| `<Leader>sg` | **S**earch by **g**rep (live search) |
| `<Leader>sw` | **S**earch current **w**ord |
| `<Leader>sr` | **S**earch **r**esume (last search) |
| `<Leader><Leader>` | Find existing buffers |

### Git Integration
| Command | Description |
|---------|-------------|
| `<Leader>gc` | **G**it **c**ommits |
| `<Leader>gf` | **G**it **f**ile history |
| `<Leader>gb` | **G**it **b**ranches |
| `<Leader>gs` | **G**it **s**tatus |
| `<Leader>gd` | **G**it **d**iff vs staging |

### Telescope Navigation
| Command | Description |
|---------|-------------|
| `<C-Enter>` | Enter fuzzy refine mode |
| `<C-q>` | Add results to quickfix list |
| `<M-q>` | Add selected items to quickfix list |
| `<Tab>` | Mark file/result (use with `<M-q>`) |

---

## 📁 File Management

### Buffer Management
| Command | Description |
|---------|-------------|
| `<Leader>x` | Close current buffer |
| `:bd` | **B**uffer **d**elete |
| `:q` | Quit window (keeps buffer) |

### Window Management
| Command | Description |
|---------|-------------|
| `<C-h>` `<C-j>` `<C-k>` `<C-l>` | Move between windows |
| `<C-w>c` | **C**lose window (keep buffer) |
| `<C-w>-` | Decrease buffer height size (prepend number to `-` to do many at once) **NOTE: this means, press Ctrl-w, wait, then press `-`** |
| `<C-w>+` | Increase buffer height size (prepend number to `+` to do many at once)|
| `<C-w><` | Move buffer width size left (prepend number to `<` to do many at once)|
| `<C-w>>` | Move buffer width size right (prepend number to `>` to do many at once)|

### Neo-tree
| Command | Description |
|---------|-------------|
| `a` | **A**dd file or directory |
| `r` | **R**ename |
| `d` | **D**elete |
| `x` | Cut |
| `c` | **C**opy |
| `p` | **P**aste |
| `R` | **R**efresh tree |

Note: renaming or moving files from Neo-tree now notifies the LSP, so TypeScript imports can update automatically when the server supports it.

Tip: for moving files or directories, `x` then navigate then `p` is usually better than a prompt-based move because it is faster and avoids typing the full destination path.

---

## 🛠️ System & Debugging

### Health & Status
| Command | Description |
|---------|-------------|
| `:checkhealth` | Check plugin/system health |
| `:Lazy` | Check plugin installations |
| `:LspInfo` | Debug LSP issues |

### Quickfix List
| Command | Description |
|---------|-------------|
| `<C-q>` | Add search results to quickfix |
| `<M-q>` | Add marked items to quickfix |
| `:copen` | Open quickfix window |
| `:cnext` | Next quickfix item |
| `:cprev` | Previous quickfix item |

---

## 🎯 Custom Keybindings

### Cheatsheet
| Command | Description |
|---------|-------------|
| `<Leader>cc` | **C**heatsheet open (split) |
| `<Leader>ce` | **C**heatsheet **e**dit |
| `<Leader>cs` | **C**heatsheet **s**earch |

### Diagnostics
| Command | Description |
|---------|-------------|
| `<Leader>xx` | Toggle diagnostics (Trouble) |
| `<Leader>xX` | Buffer diagnostics (Trouble) |

### Custom Plugins/Bindings
| Command | Description |
|---------|-------------|
| `<Leader>ma` | Add a sidecar comment to a markdown file (use Visual mode to comment on selection) |
| `<Leader>mc` | View sidecar comments file |
| `<Leader>mv` | View comment in sidecar comments file |

---

## 🤖 Agentic Coding
| Command | Description |
|---------|-------------|
| `:AvanteAsk` | Ask in the Avante sidebar (uses OpenCode ACP) |
| `<Leader>aa` | Ask in the Avante sidebar (uses OpenCode ACP) |
| `<Leader>ae` | Ask AI in-inline (uses OpenCode ACP) |
| `@general <task>` (in Avante chat) | Use OpenCode general subagent within Avante Chat |
| `@explore <task>` (in Avante chat) | Use OpenCode explore subagent within Avante Chat |

---

## 💡 Pro Tips

1. **Jumplist Navigation**: Use `<C-o>` and `<C-i>` instead of `<C-^>` for better navigation history
2. **Quickfix Workflow**: Search with Telescope → `<C-q>` → Navigate with `:cnext`/`:cprev`
3. **Git Workflow**: `<Leader>gd` → `<C-q>` → Jump between changed files
4. **Macro Power**: Record complex edits with `q` and replay with `@`
5. **LSP Integration**: Use `gd` for definitions, `K` for docs, `<Leader>rn` for refactoring

---

*Last updated: $(date)*
