# tmux Reference (for this setup)

This repo sets tmux prefix to `M-Space` (Meta+Space / Option+Space).

Tip: when this guide says `prefix + x`, press `M-Space`, release, then press `x`.

## Sessions

- List sessions: `tmux ls`
- Attach to a session: `tmux attach -t <session>`
- Detach from current session: `prefix + d`
- Kill a session (from shell): `tmux kill-session -t <session>`
- Kill the current session (inside tmux): `prefix + :` then run `kill-session`

## Windows (tabs)

- New window: `prefix + c`
- Next window: `prefix + Right`
- Previous window: `prefix + p`
- Last window: `prefix + l`
- Go to window number: `prefix + 0` ... `prefix + 9`
- Rename current window: `prefix + ,`
- Kill current window: `prefix + &`
- Choose from all windows: `prefix + w`

## Panes (splits)

- Split vertically (left/right): `prefix + %`
- Split horizontally (top/bottom): `prefix + "`
- Move between panes: `prefix + Arrow keys`
- Resize pane: `prefix + Ctrl + Arrow keys`
- Toggle zoom for active pane: `prefix + z`
- Kill current pane: `prefix + x`

## Copy/scroll mode

- Enter copy mode: `prefix + [`
- Move in history with arrows/PageUp/PageDown
- Exit copy mode: `q`

## Useful command prompt actions

- Open tmux prompt: `prefix + :`
- Reload tmux config: `prefix + :` then `source-file ~/.tmux.conf`
- Show current prefix key: `prefix + :` then `show -g prefix`

## Workflow keys from this repo

With `prefix` set to `M-Space`:

- `prefix + n` -> local dev session (`dnew`)
- `prefix + N` -> local dev session (`dnew`)
- `prefix + t` -> new worktree session (`dtree`)
- `prefix + W` -> new worktree session (`dtree`)
- `prefix + M` -> merge current branch back (`dmerge`)

## If Option/Meta does not work

Some terminals need Option/Alt mapped to Meta.

- iTerm2: Profiles -> Keys -> Left/Right Option Key -> `Esc+`
- Ghostty/Kitty/Alacritty: enable Alt/Option as Meta in terminal config

Then reload tmux config:

```bash
tmux source-file ~/.tmux.conf
```
