# Config

Herein lies my configuration files

## Setup

Run `./setup.sh` from this repository to install the full config.

It will:

- symlink each top-level dotfile in this repo into your home directory
- skip `.git` and `.gitignore`
- run `./tmux_and_worktrees/setup.sh` to install the tmux/worktree helpers
- reload tmux config automatically when a tmux server is already running

If you only want the dotfile symlinks, run `./symlink_dotfiles.sh` directly. For shell changes, open a new shell or run `source ~/.zprofile`.

## [Tmux and Worktrees](./tmux_and_worktrees)

Simply run `bash ./tmux_and_worktrees/setup.sh` to set up tmux and worktree commands (see [the README](./tmux_and_worktrees/README.md) for instructions/dependencies).
