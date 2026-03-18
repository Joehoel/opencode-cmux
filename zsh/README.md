# cmux zsh integrations

Azure DevOps, Jira, and shell integrations for cmux. All API calls run in background async workers — the prompt never blocks.

## Install

Add to `~/.zshrc`:

```bash
source "$HOME/Developer/opencode-cmux/zsh/cmux-integrations.zsh"
```

Restart your shell or `source ~/.zshrc`.

## Requirements

- `cmux` running with socket
- `jira` (ankitpokhrel/jira-cli) for Jira features
- `az` (Azure CLI + `azure-devops` extension) for PR/pipeline features
- `git`

## What happens automatically

| Feature | Trigger | What it does |
|---|---|---|
| Workspace rename | `cd` into a git repo | Names workspace after Jira ticket + description |
| Repo pill | `cd` into a git repo | Shows `RN`, `Next`, or repo name in sidebar |
| Jira ticket pill | Branch has `COAP-1234` etc. | Shows ticket key + status (polls every 10 min) |
| PR status pill | Azure DevOps PR exists for branch | Shows `PR #1234 · 1/2 approved` (polls every 2 min) |
| Pipeline progress | Pipeline running for branch | Shows progress bar + status pill (polls every 30s while active) |
| Pipeline failure notify | Pipeline fails | Desktop notification + workspace flash |
| Command timer | Any command > 5s | Desktop notification with duration |
| Exit status pill | Every command | Green check or red X in sidebar |
| Branch change detect | `git checkout`, `git switch` | Re-fetches Jira/PR/pipeline for new branch |
| Cleanup on leave | `cd` out of repo or close shell | Clears all pills, progress, poller |

## On-demand commands

### `cmux-pr`

```bash
cmux-pr              # Show PR status for current branch
cmux-pr status       # Same as above
cmux-pr create       # Create PR with Jira-linked title/description
```

`cmux-pr create` auto-fills:
- Title: `COAP-1234 | description from branch name`
- Description: `[Ticket](https://jira.example.com/browse/COAP-1234)`
- Target: auto-detected main branch
- Opens PR in browser after creation

### `cmux-jira`

```bash
cmux-jira            # Show ticket info for current branch
cmux-jira status     # Same as above
cmux-jira transition "In Review"   # Move ticket to a new status
cmux-jira open       # Open ticket in browser
```

### `cmux-pipeline`

```bash
cmux-pipeline        # Show latest pipeline run for current branch
cmux-pipeline status # Same as above
```

## Polling intervals

| Data | Interval | Notes |
|---|---|---|
| Jira ticket | 10 min | Negligible API load |
| PR status | 2 min | Lightweight Azure DevOps call |
| Pipeline (active) | 30s | Only while a run is `inProgress` |
| Pipeline (idle) | 5 min | Falls back when no active run |

All intervals can be overridden by setting env vars before sourcing:

```bash
export CMUX_INT_JIRA_TTL=300          # 5 min instead of 10
export CMUX_INT_PR_TTL=60             # 1 min instead of 2
export CMUX_INT_PIPELINE_ACTIVE_TTL=15
export CMUX_INT_CMD_THRESHOLD=10      # Notify after 10s instead of 5
source "$HOME/Developer/opencode-cmux/zsh/cmux-integrations.zsh"
```

## How it stays fast

- All API calls run in `zsh-async` background workers (vendored at `vendor/async.zsh`).
- Hooks (`chpwd`, `precmd`, `preexec`) only do fast local operations (git reads, variable checks).
- Dedup layer: cmux commands only fire when a value actually changed.
- Cache files in `/tmp/cmux-integrations/` avoid redundant fetches within TTL windows.
- Poller stops automatically when you leave a repo or close the shell.
