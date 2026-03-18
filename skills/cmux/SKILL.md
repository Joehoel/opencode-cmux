---
name: cmux
description: Control the cmux terminal multiplexer from coding agents. Use when managing workspaces, panes, tabs, notifications, sidebar metadata, terminal input, or browser automation through the cmux CLI.
compatibility: macOS with cmux app running and cmux CLI available on PATH.
---

# cmux Skill

cmux is a macOS terminal multiplexer with a socket API exposed by the `cmux` CLI.
Use this skill when the user asks to control cmux, route terminal input, update sidebar metadata, send notifications, or automate browser surfaces.

## When to use

- User mentions `cmux` directly.
- User asks to create/select/close workspaces or split panes.
- User asks to send text/keys into a cmux terminal.
- User asks for desktop notifications through cmux.
- User asks to set sidebar status/progress/log entries.
- User asks to automate a page in a cmux browser tab.

## Preflight

Run this before cmux actions:

```bash
command -v cmux >/dev/null && cmux ping
```

If this fails, report that cmux is unavailable and stop cmux-specific automation.

## Targeting and safety

cmux commands can default to focused objects or environment variables (`CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`).
To avoid mistakes:

1. Inspect context first.
2. Use explicit IDs for non-trivial operations.
3. Re-check state after mutating actions.

```bash
cmux identify --json
cmux tree --workspace workspace:2
```

## Fast command map

### Workspace and layout

```bash
cmux list-workspaces
cmux current-workspace --json
cmux new-workspace
cmux select-workspace --workspace workspace:2
cmux close-workspace --workspace workspace:2

cmux new-split right
cmux new-split down
cmux list-panes --workspace workspace:2
cmux list-pane-surfaces --workspace workspace:2 --pane pane:1
cmux new-surface --type terminal --workspace workspace:2
cmux close-surface --surface surface:4
```

### Terminal input and output

```bash
cmux send --surface surface:4 "npm test\n"
cmux send-key --surface surface:4 enter
cmux read-screen --surface surface:4 --lines 120
```

### Notifications

```bash
cmux notify --title "Build" --body "Completed"
cmux list-notifications --json
cmux clear-notifications
```

### Sidebar metadata

```bash
cmux set-status build "running" --icon hammer --color "#ff9500"
cmux clear-status build
cmux set-progress 0.35 --label "Running tests"
cmux clear-progress
cmux log --level info --source agent "Started task"
cmux list-log --limit 20
cmux sidebar-state --workspace workspace:2
```

### Browser automation

```bash
cmux browser open https://example.com
cmux browser identify
cmux browser surface:7 wait --load-state complete --timeout-ms 15000
cmux browser surface:7 snapshot --interactive --compact
cmux browser surface:7 click "button[type='submit']" --snapshot-after
```

For full browser patterns, use `references/browser-automation.md`.

## Recommended workflows

### 1) Start a focused workspace for a task

```bash
cmux new-workspace
cmux rename-workspace --workspace workspace:5 "feature-x"
cmux new-split right --workspace workspace:5
cmux new-surface --type terminal --workspace workspace:5
cmux tree --workspace workspace:5
```

### 2) Run a command in a known surface and inspect output

```bash
cmux send --workspace workspace:5 --surface surface:9 "pnpm build\n"
cmux read-screen --workspace workspace:5 --surface surface:9 --lines 160
```

### 3) Show live progress in sidebar

```bash
cmux set-status agent "working" --icon bolt --color "#007aff"
cmux set-progress 0.1 --label "Scanning repo"
cmux set-progress 0.6 --label "Applying edits"
cmux set-progress 1.0 --label "Done"
cmux clear-progress
cmux clear-status agent
```

### 4) Browser task loop

```bash
cmux browser open https://app.example.com/login
cmux browser identify
cmux browser surface:3 fill "#email" --text "dev@example.com"
cmux browser surface:3 fill "#password" --text "$PASSWORD"
cmux browser surface:3 click "button[type='submit']" --snapshot-after
cmux browser surface:3 wait --text "Dashboard" --timeout-ms 15000
cmux browser surface:3 screenshot --out /tmp/dashboard.png
```

## Troubleshooting

- `Unknown command`: check against current CLI help (`cmux help` or `cmux browser --help`).
- No target selected: run `cmux identify` and pass `--workspace`/`--surface` explicitly.
- Browser command fails: confirm target is a browser surface using `cmux browser identify`.
- No notification appears: verify macOS notification permissions for cmux.

## References

- CLI command reference: `references/cli-cheatsheet.md`
- Browser automation reference: `references/browser-automation.md`
