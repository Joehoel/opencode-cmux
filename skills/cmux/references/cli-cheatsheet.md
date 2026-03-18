# cmux CLI Cheatsheet

Quick, current command reference for common cmux operations.

## Preflight

```bash
command -v cmux >/dev/null
cmux ping
cmux capabilities --json
```

## Identify current context

```bash
cmux identify
cmux identify --json
cmux tree
cmux tree --workspace workspace:2
```

## IDs and targeting

- Accepts UUIDs and short refs like `window:1`, `workspace:2`, `pane:3`, `surface:4`.
- Many commands default to `CMUX_WORKSPACE_ID` and `CMUX_SURFACE_ID` when running inside cmux.
- For reliable automation, pass explicit `--workspace` and `--surface` whenever possible.

## Window commands

```bash
cmux list-windows
cmux current-window
cmux new-window
cmux focus-window --window window:2
cmux close-window --window window:2
```

## Workspace commands

```bash
cmux list-workspaces
cmux current-workspace
cmux current-workspace --json
cmux new-workspace
cmux select-workspace --workspace workspace:2
cmux rename-workspace --workspace workspace:2 "feature-x"
cmux close-workspace --workspace workspace:2
```

## Pane and surface commands

```bash
cmux new-split right
cmux new-split down

cmux list-panes --workspace workspace:2
cmux list-pane-surfaces --workspace workspace:2 --pane pane:1

cmux focus-pane --workspace workspace:2 --pane pane:1
cmux new-pane --type terminal --workspace workspace:2
cmux new-surface --type terminal --workspace workspace:2
cmux close-surface --surface surface:4

cmux move-surface --surface surface:4 --pane pane:2
cmux reorder-surface --surface surface:4 --index 0
```

## Surface tab actions

```bash
cmux tab-action --tab surface:4 --action rename --title "server logs"
cmux tab-action --tab surface:4 --action pin
cmux tab-action --tab surface:4 --action close-others
```

## Terminal I/O

```bash
cmux send --workspace workspace:2 --surface surface:4 "npm test\n"
cmux send-key --workspace workspace:2 --surface surface:4 enter
cmux read-screen --workspace workspace:2 --surface surface:4 --lines 120
cmux read-screen --workspace workspace:2 --surface surface:4 --scrollback
```

## Notifications

```bash
cmux notify --title "Build" --body "Completed"
cmux notify --title "Deploy" --subtitle "staging" --body "Finished"
cmux list-notifications
cmux clear-notifications
```

## Sidebar metadata

```bash
cmux set-status build "running" --icon hammer --color "#ff9500"
cmux clear-status build
cmux list-status

cmux set-progress 0.25 --label "Running tests"
cmux clear-progress

cmux log --level info --source agent "Task started"
cmux log --level error --source build "Compilation failed"
cmux list-log --limit 20
cmux clear-log

cmux sidebar-state
cmux sidebar-state --workspace workspace:2
```

## Browser entry points

```bash
cmux browser open https://example.com
cmux browser open-split https://example.com
cmux browser identify
cmux browser identify --surface surface:7
```

Full browser automation commands are in `browser-automation.md`.

## Common compatibility notes

If you are migrating from older scripts/instructions:

- `list-surfaces` -> use `list-pane-surfaces` or `tree`
- `focus-surface` -> use `focus-pane` plus surface-targeted commands
- `send-surface` -> use `send --surface <id>`
- `send-key-surface` -> use `send-key --surface <id>`

## Environment variables

- `CMUX_WORKSPACE_ID`: current workspace ID
- `CMUX_SURFACE_ID`: current surface ID
- `CMUX_TAB_ID`: optional default tab ID for tab actions
- `CMUX_SOCKET_PATH`: override socket path

Default socket auto-discovery is built into cmux CLI. `CMUX_SOCKET_PATH` is optional.
