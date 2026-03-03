# Dev Config: tmux + git worktrees

This directory contains a portable tmux/worktree workflow you can copy into its own repo.

## What it sets up

- `dnew` -> normal dev tmux session in current repo/path
- `dTree <branch> [base]` -> create/switch to a git worktree + tmux session
- `dmerge [branch] [main] [--keep]` -> merge branch back and clean up

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
- add aliases (`dnew`, `dTree`, `dmerge`) to `~/.zprofile`
- source tmux bindings from `~/.tmux.worktree.conf`

## tmux keybinds

Use your existing tmux prefix key, then:

- `N` -> local dev session (`dnew`)
- `W` -> new worktree session (`dTree`)
- `M` -> merge current branch back (`dmerge`)

## Recommended repo layout

```text
/path/to/project/repo   # main checkout
/path/to/project/wk     # worktrees
```

`dTree` creates worktrees under `wk/<branch>`.
