# opencode-cmux

One repository for:

- `opencode-cmux`: an OpenCode plugin that updates cmux sidebar status and sends desktop notifications.
- `cmux` skill: a publishable Agent Skill for controlling cmux from coding agents.

## OpenCode plugin (npm)

When published, add this plugin package in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cmux"]
}
```

For local development before publishing, symlink it as a local plugin:

```bash
ln -sf "$HOME/Developer/opencode-cmux/src/index.js" "$HOME/.config/opencode/plugins/cmux-notify.js"
```

### Behavior

- On `session.status` busy: sets a cmux status pill (`opencode`, `working`, bolt icon, blue color).
- On `session.idle`: clears status pill and sends "Session complete" notification.
- On `session.error`: clears status pill and sends "Session errored" notification.

The plugin no-ops when `cmux` is unavailable or `cmux ping` fails.

### Optional environment variables

- `CMUX_STATUS_KEY` (default: `opencode`)
- `CMUX_STATUS_TEXT` (default: `working`)
- `CMUX_STATUS_ICON` (default: `bolt`)
- `CMUX_STATUS_COLOR` (default: `#007aff`)

## Agent Skill (skills.sh)

This repo exposes a `cmux` skill at `skills/cmux/SKILL.md`.

Install from a local path while developing:

```bash
npx skills add "$HOME/Developer/opencode-cmux" --skill cmux -a opencode -y
```

Install from GitHub later:

```bash
npx skills add joelkuijper/opencode-cmux --skill cmux -a opencode -y
```

## Verify before publishing

```bash
npm run check
npm run pack:dry-run
npx skills add "$HOME/Developer/opencode-cmux" --list
```

## Publishing checklist (not executed here)

1. Push this repo to GitHub.
2. Create npm access token and run `npm login`.
3. Publish with `npm publish --access public`.
4. Install with `plugin: ["opencode-cmux"]` in OpenCode.
5. Let users install the skill via `npx skills add joelkuijper/opencode-cmux`.

For a command-by-command release runbook, see `RELEASE.md`.
