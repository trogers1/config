# Dev Config: tmux + git worktrees

This directory contains a portable tmux/worktree workflow you can copy into its own repo.

## What it sets up

- `dnew` -> normal dev tmux session in current repo/path
- `dtree <branch> [base]` -> create/switch to a git worktree + tmux session (defaults base to current branch)
- `dmerge [branch] [target] [--keep]` -> interactively choose merge target and clean up

Each dev session opens 4 tmux windows:

1. `nvim`
2. `opencode`
3. `lazygit`
4. `term`

## Install

From this directory:

```bash
bash setup.sh
source ~/.zprofile
tmux source-file ~/.tmux.conf
```

`setup.sh` will:

- symlink scripts into `~/bin`
- ensure `~/bin` is on `PATH` in `~/.zprofile`
- add aliases (`dnew`, `dtree`, `dmerge`) to `~/.zprofile`
- source tmux bindings from `~/.tmux.worktree.conf`

## tmux keybinds

Prefix is `M-Space` (Meta+Space), then:

- `n` -> local dev session (`dnew`)
- `N` -> local dev session (`dnew`)
- `t` -> new worktree session (`dtree`)
- `W` -> new worktree session (`dtree`)
- `M` -> run `dmerge` in-pane (interactive target prompt)

## Recommended repo layout

```text
/path/to/project/repo   # main checkout
/path/to/project/wk     # worktrees
```

`dtree` creates worktrees under `wk/<branch>`.

When creating a new branch, `dtree` bases it on your current branch by default.
If your current HEAD is detached, it falls back to `main`.

## Worktree bootstrap (one-command setup)

`dtree` now runs a bootstrap step before opening a brand new tmux session.

Default behavior (if no custom script is found):

- symlink `.env` from the main checkout if missing in the worktree
- install dependencies when `package.json` exists and `node_modules` is missing
  - uses `npm ci` when `package-lock.json` exists
  - otherwise uses `npm install`

To customize setup per project, add either of these scripts in your main checkout:

- `.worktree-init.sh`
- `scripts/worktree-init.sh`

If present, `dtree` will run that script instead of the default bootstrap.

Example:

```bash
#!/bin/bash
set -euo pipefail

# Called with cwd set to the new worktree.
# Available env vars:
# - REPO_ROOT (main checkout path)
# - WORKTREE_PATH (new worktree path)

if [ ! -e .env ] && [ -f "$REPO_ROOT/.env" ]; then
  ln -s "$REPO_ROOT/.env" .env
fi

if [ -f package.json ] && [ ! -d node_modules ]; then
  npm ci
fi
```
