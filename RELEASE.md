# Release Checklist

This repo ships two artifacts:

- npm package: `opencode-cmux` (OpenCode plugin)
- Agent Skill: `skills/cmux`

## 1) Preflight checks

Run from repo root:

```bash
npm run check
npm run pack:dry-run
npx skills add "$PWD" --list
```

Optional local install checks:

```bash
npx skills add "$PWD" --skill cmux -a opencode -g -y
ln -sf "$PWD/src/index.js" "$HOME/.config/opencode/plugins/cmux-notify.js"
```

## 2) Publish to npm

Do this only when you are ready for a public release.

```bash
npm whoami
npm publish --access public
```

If not logged in:

```bash
npm login
npm whoami
npm publish --access public
```

## 3) Post-publish verification

Install package in OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cmux"]
}
```

Verify package metadata from npm:

```bash
npm view opencode-cmux name version dist-tags.latest
```

## 4) Skill distribution verification

From a clean machine or environment:

```bash
npx skills add joelkuijper/opencode-cmux --list
npx skills add joelkuijper/opencode-cmux --skill cmux -a opencode -g -y
```

## 5) Suggested release flow

```bash
git pull --rebase
npm run check
npm run pack:dry-run
git tag v0.1.0
git push origin main --tags
npm publish --access public
```
