# opencode-cmux

One repository for:

- `@joehoel/opencode-cmux`: an OpenCode plugin that updates cmux sidebar status and sends desktop notifications.
- `cmux` skill: a publishable Agent Skill for controlling cmux from coding agents.

## OpenCode plugin (npm)

When published, add this plugin package in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@joehoel/opencode-cmux"]
}
```

For local development before publishing, symlink it as a local plugin:

```bash
ln -sf "$HOME/Developer/opencode-cmux/src/index.js" "$HOME/.config/opencode/plugins/cmux-notify.js"
```

### Behavior

- On `session.status` busy: sets a cmux status pill (`opencode`, `working`, bolt icon, blue color).
- On `todo.updated`: drives the cmux sidebar progress bar (`Tasks x/y`) and clears it when work finishes.
- On permission requests: sets `waiting` status and sends a detailed "Needs your permission" notification.
- On question prompts: sets `question` status and sends a detailed "Has a question" notification.
- On primary `session.idle`: sends `Done: <session title>` with change summary when available.
- On subagent `session.idle`: logs completion without desktop notification spam.
- On `session.error`: sends `Error: <session title>` with error type/message and writes an error log entry.
- On permission/question/error: marks the workspace as unread and triggers flash; it marks read again when active work resumes.

Idle completion notifications are suppressed while the agent is waiting for permission/question input.

The plugin writes timeline entries via `cmux log` for permission requests, questions, completions, and errors.
When session workspace IDs are available, metadata updates are targeted to the correct cmux workspace.
The plugin uses built-in defaults and does not require runtime environment-variable configuration.

The plugin no-ops when `cmux` is unavailable or `cmux ping` fails.

## Agent Skill (skills.sh)

This repo exposes a `cmux` skill at `skills/cmux/SKILL.md`.

Install from a local path while developing:

```bash
npx skills add "$HOME/Developer/opencode-cmux" --skill cmux -a opencode -y
```

Install from GitHub later:

```bash
npx skills add Joehoel/opencode-cmux --skill cmux -a opencode -y
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
4. Install with `plugin: ["@joehoel/opencode-cmux"]` in OpenCode.
5. Let users install the skill via `npx skills add Joehoel/opencode-cmux`.

For a command-by-command release runbook, see `RELEASE.md`.
