#!/usr/bin/env zsh
# cmux-integrations.zsh — Azure DevOps, Jira, and shell integrations for cmux.
#
# Source this file from ~/.zshrc:
#   source "$HOME/Developer/opencode-cmux/zsh/cmux-integrations.zsh"
#
# All API calls run in background async workers — the prompt never blocks.

# Guard: only load once, require cmux + interactive shell.
(( _CMUX_INT_LOADED )) && return
typeset -gi _CMUX_INT_LOADED=1

[[ -o interactive ]] || return
command -v cmux &>/dev/null || return
cmux ping &>/dev/null || return

# ---------------------------------------------------------------------------
# Configuration (override before sourcing to customize)
# ---------------------------------------------------------------------------
: ${CMUX_INT_CACHE_DIR:=/tmp/cmux-integrations}
: ${CMUX_INT_CMD_THRESHOLD:=5}         # Notify after N seconds
: ${CMUX_INT_JIRA_TTL:=600}            # Jira ticket cache: 10 min
: ${CMUX_INT_PR_TTL:=120}              # PR cache: 2 min
: ${CMUX_INT_PIPELINE_ACTIVE_TTL:=30}  # Pipeline poll while running: 30s
: ${CMUX_INT_PIPELINE_IDLE_TTL:=300}   # Pipeline poll when idle: 5 min
: ${CMUX_INT_POLL_INTERVAL:=15}        # Unified poller tick: 15s

mkdir -p "$CMUX_INT_CACHE_DIR" 2>/dev/null

# ---------------------------------------------------------------------------
# Vendor: zsh-async
# ---------------------------------------------------------------------------
source "${0:A:h}/vendor/async.zsh"
async_init

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
typeset -g  _cmux_int_repo_root=""
typeset -g  _cmux_int_repo_name=""
typeset -g  _cmux_int_branch=""
typeset -g  _cmux_int_ticket=""
typeset -g  _cmux_int_remote_url=""
typeset -g  _cmux_int_az_repo=""
typeset -g  _cmux_int_main_branch=""
typeset -g  _cmux_int_workspace_id=""

# Last-sent values for dedup.
typeset -g  _cmux_int_last_jira_pill=""
typeset -g  _cmux_int_last_pr_pill=""
typeset -g  _cmux_int_last_pipeline_pill=""
typeset -g  _cmux_int_last_pipeline_progress=""
typeset -g  _cmux_int_last_workspace_title=""

# Command timing.
typeset -gi _cmux_int_cmd_start=0
typeset -g  _cmux_int_cmd_text=""

# Poller state.
typeset -gi _cmux_int_poller_active=0

# Cache timestamps.
typeset -gi _cmux_int_jira_last_fetch=0
typeset -gi _cmux_int_pr_last_fetch=0
typeset -gi _cmux_int_pipeline_last_fetch=0

# Pipeline state.
typeset -g  _cmux_int_pipeline_status=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_cmux_int_safe() { "$@" &>/dev/null }

_cmux_int_cache_file() { print -r -- "$CMUX_INT_CACHE_DIR/$1" }

_cmux_int_cache_fresh() {
  local file=$1 ttl=$2
  [[ -f $file ]] || return 1
  local mtime=$(stat -f %m "$file" 2>/dev/null || echo 0)
  (( EPOCHSECONDS - mtime < ttl ))
}

_cmux_int_set_status() {
  local key=$1 text=$2 icon=$3 color=$4
  local -a args=(set-status "$key" "$text" --icon "$icon" --color "$color")
  [[ -n $_cmux_int_workspace_id ]] && args+=(--workspace "$_cmux_int_workspace_id")
  _cmux_int_safe cmux "${args[@]}"
}

_cmux_int_clear_status() {
  local -a args=(clear-status "$1")
  [[ -n $_cmux_int_workspace_id ]] && args+=(--workspace "$_cmux_int_workspace_id")
  _cmux_int_safe cmux "${args[@]}"
}

_cmux_int_log() {
  local -a args=(log --level "$1" --source "shell")
  [[ -n $_cmux_int_workspace_id ]] && args+=(--workspace "$_cmux_int_workspace_id")
  args+=(-- "$2")
  _cmux_int_safe cmux "${args[@]}"
}

# Workspace-scoped cmux command wrapper.
_cmux_int_ws_cmd() {
  local -a args=("$@")
  [[ -n $_cmux_int_workspace_id ]] && args+=(--workspace "$_cmux_int_workspace_id")
  _cmux_int_safe cmux "${args[@]}"
}

# ---------------------------------------------------------------------------
# Git / repo detection (fast, synchronous — only reads local git)
# ---------------------------------------------------------------------------
_cmux_int_detect_repo() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    _cmux_int_repo_root=""
    _cmux_int_repo_name=""
    _cmux_int_branch=""
    _cmux_int_ticket=""
    _cmux_int_remote_url=""
    _cmux_int_az_repo=""
    _cmux_int_main_branch=""
    return 1
  }

  _cmux_int_repo_root="$root"
  _cmux_int_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")

  # Get remote URL.
  _cmux_int_remote_url=$(git remote get-url origin 2>/dev/null || echo "")

  # Extract Azure DevOps repo name from remote URL.
  if [[ $_cmux_int_remote_url == *dev.azure.com* ]]; then
    # HTTPS: https://org@dev.azure.com/org/project/_git/repo
    # SSH:   git@ssh.dev.azure.com:v3/org/project/repo
    if [[ $_cmux_int_remote_url == */_git/* ]]; then
      _cmux_int_az_repo="${_cmux_int_remote_url##*/_git/}"
    elif [[ $_cmux_int_remote_url == *:v3/* ]]; then
      _cmux_int_az_repo="${_cmux_int_remote_url##*/}"
    else
      _cmux_int_az_repo=""
    fi
    # URL-decode %20 → space.
    _cmux_int_az_repo="${_cmux_int_az_repo//%20/ }"
  else
    _cmux_int_az_repo=""
  fi

  # Repo display name from package.json name field or directory basename.
  _cmux_int_repo_name=""
  if [[ -f "$root/package.json" ]]; then
    local pkg_name
    pkg_name=$(rg -m1 --no-filename -o '"name"\s*:\s*"([^"]+)"' -r '$1' "$root/package.json" 2>/dev/null)
    if [[ -n $pkg_name ]]; then
      # Strip scope.
      _cmux_int_repo_name="${pkg_name#@*/}"
    fi
  fi
  [[ -z $_cmux_int_repo_name ]] && _cmux_int_repo_name="${root:t}"

  # Parse Jira ticket from branch name.
  if [[ $_cmux_int_branch =~ '([A-Z]+-[0-9]+)' ]]; then
    _cmux_int_ticket="${match[1]}"
  else
    _cmux_int_ticket=""
  fi

  # Detect main/default branch (fast — local refs only).
  _cmux_int_main_branch=""
  for ref in refs/remotes/origin/main refs/remotes/origin/master refs/remotes/origin/develop; do
    if git show-ref --verify --quiet "$ref" 2>/dev/null; then
      _cmux_int_main_branch="${ref##*/}"
      break
    fi
  done
  [[ -z $_cmux_int_main_branch ]] && _cmux_int_main_branch="main"

  return 0
}

# ---------------------------------------------------------------------------
# Async worker: fetch jobs (these run in background workers)
# ---------------------------------------------------------------------------

# Jira ticket fetch — runs inside async worker.
_cmux_int_fetch_jira() {
  local ticket=$1
  local cache_file="$CMUX_INT_CACHE_DIR/jira-${ticket}.json"

  local raw
  raw=$(jira issue view "$ticket" --plain 2>/dev/null) || { print ""; return 1 }

  # Parse summary and status from plain output.
  local summary status
  summary=$(echo "$raw" | rg -m1 -o '^Summary:\s*(.+)' -r '$1' 2>/dev/null)
  status=$(echo "$raw" | rg -m1 -o '^Status:\s*(.+)' -r '$1' 2>/dev/null)

  [[ -z $summary ]] && { print ""; return 1 }

  # Write cache.
  print -r -- "${ticket}|${status}|${summary}" > "$cache_file"
  print -r -- "${ticket}|${status}|${summary}"
}

# Azure PR fetch — runs inside async worker.
_cmux_int_fetch_pr() {
  local repo=$1 branch=$2
  local cache_file="$CMUX_INT_CACHE_DIR/pr-${repo//[^a-zA-Z0-9_-]/_}-${branch//\//_}.json"

  local json
  json=$(az repos pr list -r "$repo" -s "$branch" --status active --top 1 -o json 2>/dev/null) || { print ""; return 1 }

  # Check if result array is empty.
  local count
  count=$(echo "$json" | rg -c '"pullRequestId"' 2>/dev/null || echo 0)
  (( count == 0 )) && { print "none"; echo "none" > "$cache_file"; return 0 }

  # Parse first PR.
  local pr_id title pr_status
  pr_id=$(echo "$json" | rg -m1 -o '"pullRequestId"\s*:\s*(\d+)' -r '$1' 2>/dev/null)
  title=$(echo "$json" | rg -m1 -o '"title"\s*:\s*"([^"]+)"' -r '$1' 2>/dev/null)
  pr_status=$(echo "$json" | rg -m1 -o '"status"\s*:\s*"([^"]+)"' -r '$1' 2>/dev/null)

  # Count reviewers and approvals.
  local total_reviewers approved
  total_reviewers=$(echo "$json" | rg -c '"uniqueName"' 2>/dev/null || echo 0)
  approved=$(echo "$json" | rg -c '"vote"\s*:\s*10' 2>/dev/null || echo 0)

  local result="${pr_id}|${title}|${pr_status}|${approved}/${total_reviewers}"
  print -r -- "$result" > "$cache_file"
  print -r -- "$result"
}

# Azure pipeline fetch — runs inside async worker.
_cmux_int_fetch_pipeline() {
  local repo=$1 branch=$2
  local cache_file="$CMUX_INT_CACHE_DIR/pipeline-${repo//[^a-zA-Z0-9_-]/_}-${branch//\//_}.json"

  local json
  json=$(az pipelines runs list --branch "refs/heads/$branch" --top 1 --query-order FinishTimeDesc -o json 2>/dev/null) || { print ""; return 1 }

  local count
  count=$(echo "$json" | rg -c '"id"' 2>/dev/null || echo 0)
  (( count == 0 )) && { print "none"; echo "none" > "$cache_file"; return 0 }

  local run_id run_status run_result pipeline_name
  run_id=$(echo "$json" | rg -m1 -o '^\s*"id"\s*:\s*(\d+)' -r '$1' 2>/dev/null)
  run_status=$(echo "$json" | rg -m1 -o '"status"\s*:\s*"([^"]+)"' -r '$1' 2>/dev/null)
  run_result=$(echo "$json" | rg -m1 -o '"result"\s*:\s*"([^"]+)"' -r '$1' 2>/dev/null)
  pipeline_name=$(echo "$json" | rg -m1 -o '"name"\s*:\s*"([^"]+)"' -r '$1' 2>/dev/null)

  # If run is in progress, try to get timeline for job-level progress.
  local completed_jobs total_jobs
  completed_jobs=0
  total_jobs=0

  if [[ $run_status == "inProgress" ]]; then
    local timeline
    timeline=$(az devops invoke \
      --area build --resource builds \
      --route-parameters buildId="$run_id" project="Apps and Services" \
      --api-version 7.0 \
      --http-method GET \
      --query-parameters 'api-version=7.0' \
      -o json 2>/dev/null)

    # Fallback: try timeline endpoint directly.
    if [[ -z $timeline ]]; then
      timeline=$(az rest \
        --method get \
        --uri "https://dev.azure.com/evangelischeomroep/Apps%20and%20Services/_apis/build/builds/${run_id}/timeline?api-version=7.0" \
        -o json 2>/dev/null)
    fi

    if [[ -n $timeline ]]; then
      total_jobs=$(echo "$timeline" | rg -c '"type"\s*:\s*"Job"' 2>/dev/null || echo 0)
      completed_jobs=$(echo "$timeline" | rg '"type"\s*:\s*"Job"' -A5 2>/dev/null \
        | rg -c '"state"\s*:\s*"completed"' 2>/dev/null || echo 0)
    fi
  fi

  local result="${run_id}|${run_status}|${run_result}|${pipeline_name}|${completed_jobs}/${total_jobs}"
  print -r -- "$result" > "$cache_file"
  print -r -- "$result"
}

# ---------------------------------------------------------------------------
# Async callback: process results and update cmux sidebar.
# ---------------------------------------------------------------------------
_cmux_int_async_callback() {
  local job_name=$1 return_code=$2 stdout=$3 duration=$4 stderr=$5

  case $job_name in
    _cmux_int_fetch_jira)
      if [[ $return_code -eq 0 ]] && [[ -n $stdout ]]; then
        local ticket status summary
        ticket="${stdout%%|*}"
        local rest="${stdout#*|}"
        status="${rest%%|*}"
        summary="${rest#*|}"

        local pill_text="${ticket} · ${status}"
        if [[ $pill_text != $_cmux_int_last_jira_pill ]]; then
          _cmux_int_last_jira_pill="$pill_text"

          # Color based on status.
          local color="#007aff"
          case "${status:l}" in
            *done*|*closed*|*resolved*) color="#22c55e" ;;
            *progress*)                 color="#f59e0b" ;;
            *review*)                   color="#a855f7" ;;
            *blocked*|*impediment*)     color="#ef4444" ;;
          esac

          _cmux_int_set_status "jira" "$pill_text" "bookmark" "$color"
        fi
      fi
      ;;

    _cmux_int_fetch_pr)
      if [[ $return_code -eq 0 ]]; then
        if [[ $stdout == "none" ]]; then
          if [[ -n $_cmux_int_last_pr_pill ]]; then
            _cmux_int_last_pr_pill=""
            _cmux_int_clear_status "pr"
          fi
        else
          local pr_id title pr_status approvals
          pr_id="${stdout%%|*}"
          local rest="${stdout#*|}"
          title="${rest%%|*}"
          rest="${rest#*|}"
          pr_status="${rest%%|*}"
          approvals="${rest#*|}"

          local pill_text="PR #${pr_id} · ${approvals} approved"
          if [[ $pill_text != $_cmux_int_last_pr_pill ]]; then
            _cmux_int_last_pr_pill="$pill_text"

            local color="#007aff"
            local approved_count="${approvals%%/*}"
            local total_count="${approvals##*/}"
            if (( total_count > 0 && approved_count == total_count )); then
              color="#22c55e"
            elif (( approved_count > 0 )); then
              color="#f59e0b"
            fi

            _cmux_int_set_status "pr" "$pill_text" "git-pull-request" "$color"
          fi
        fi
      fi
      ;;

    _cmux_int_fetch_pipeline)
      if [[ $return_code -eq 0 ]]; then
        if [[ $stdout == "none" ]]; then
          if [[ -n $_cmux_int_last_pipeline_pill ]]; then
            _cmux_int_last_pipeline_pill=""
            _cmux_int_last_pipeline_progress=""
            _cmux_int_clear_status "pipeline"
            _cmux_int_ws_cmd clear-progress
          fi
          _cmux_int_pipeline_status=""
        else
          local run_id run_status run_result pipeline_name job_progress
          run_id="${stdout%%|*}"
          local rest="${stdout#*|}"
          run_status="${rest%%|*}"
          rest="${rest#*|}"
          run_result="${rest%%|*}"
          rest="${rest#*|}"
          pipeline_name="${rest%%|*}"
          job_progress="${rest#*|}"

          _cmux_int_pipeline_status="$run_status"

          local pill_text icon color
          case $run_status in
            inProgress)
              pill_text="Pipeline · running"
              icon="loader"
              color="#f59e0b"

              # Update progress bar.
              local completed="${job_progress%%/*}"
              local total="${job_progress##*/}"
              if (( total > 0 )); then
                local ratio
                ratio=$(printf "%.2f" $(( completed * 1.0 / total )))
                local progress_text="Pipeline ${completed}/${total} jobs"
                if [[ $progress_text != $_cmux_int_last_pipeline_progress ]]; then
                  _cmux_int_last_pipeline_progress="$progress_text"
                  _cmux_int_ws_cmd set-progress "$ratio" --label "$progress_text"
                fi
              fi
              ;;
            completed)
              case $run_result in
                succeeded)
                  pill_text="Pipeline · passed"
                  icon="check"
                  color="#22c55e"
                  ;;
                failed)
                  pill_text="Pipeline · failed"
                  icon="x"
                  color="#ef4444"
                  _cmux_int_ws_cmd notify --title "Pipeline failed" --body "${pipeline_name:-Build}"
                  _cmux_int_ws_cmd workspace-action --action mark-unread
                  _cmux_int_ws_cmd trigger-flash
                  _cmux_int_log "error" "Pipeline failed: ${pipeline_name:-Build} (#${run_id})"
                  ;;
                canceled)
                  pill_text="Pipeline · canceled"
                  icon="slash"
                  color="#6b7280"
                  ;;
                *)
                  pill_text="Pipeline · ${run_result:-unknown}"
                  icon="minus"
                  color="#6b7280"
                  ;;
              esac

              # Clear progress bar when pipeline finishes.
              if [[ -n $_cmux_int_last_pipeline_progress ]]; then
                _cmux_int_last_pipeline_progress=""
                _cmux_int_ws_cmd clear-progress
              fi
              ;;
            *)
              pill_text="Pipeline · ${run_status}"
              icon="minus"
              color="#6b7280"
              ;;
          esac

          if [[ $pill_text != $_cmux_int_last_pipeline_pill ]]; then
            _cmux_int_last_pipeline_pill="$pill_text"
            _cmux_int_set_status "pipeline" "$pill_text" "$icon" "$color"
          fi
        fi
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Poller: unified tick that dispatches async jobs based on TTL.
# ---------------------------------------------------------------------------
_cmux_int_poll_tick() {
  [[ -z $_cmux_int_repo_root ]] && return

  local now=$EPOCHSECONDS

  # Jira.
  if [[ -n $_cmux_int_ticket ]] && (( now - _cmux_int_jira_last_fetch >= CMUX_INT_JIRA_TTL )); then
    _cmux_int_jira_last_fetch=$now
    async_job cmux_poller _cmux_int_fetch_jira "$_cmux_int_ticket"
  fi

  # PR.
  if [[ -n $_cmux_int_az_repo ]] && (( now - _cmux_int_pr_last_fetch >= CMUX_INT_PR_TTL )); then
    _cmux_int_pr_last_fetch=$now
    async_job cmux_poller _cmux_int_fetch_pr "$_cmux_int_az_repo" "$_cmux_int_branch"
  fi

  # Pipeline (adaptive TTL).
  if [[ -n $_cmux_int_az_repo ]]; then
    local pipeline_ttl=$CMUX_INT_PIPELINE_IDLE_TTL
    [[ $_cmux_int_pipeline_status == "inProgress" ]] && pipeline_ttl=$CMUX_INT_PIPELINE_ACTIVE_TTL

    if (( now - _cmux_int_pipeline_last_fetch >= pipeline_ttl )); then
      _cmux_int_pipeline_last_fetch=$now
      async_job cmux_poller _cmux_int_fetch_pipeline "$_cmux_int_az_repo" "$_cmux_int_branch"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Poller lifecycle.
# ---------------------------------------------------------------------------
_cmux_int_start_poller() {
  (( _cmux_int_poller_active )) && return

  async_start_worker cmux_poller -u
  async_register_callback cmux_poller _cmux_int_async_callback

  _cmux_int_poller_active=1

  # Reset fetch timestamps to trigger immediate first fetch.
  _cmux_int_jira_last_fetch=0
  _cmux_int_pr_last_fetch=0
  _cmux_int_pipeline_last_fetch=0

  # Immediate first tick.
  _cmux_int_poll_tick

  # Register periodic polling via TMOUT.
  # We piggyback on the TRAPALRM approach: set a periodic function.
  if (( ! ${+functions[_cmux_int_original_periodic]} )); then
    # Save existing periodic function if any.
    if (( ${+functions[periodic]} )); then
      functions[_cmux_int_original_periodic]="${functions[periodic]}"
    fi
  fi

  PERIOD=$CMUX_INT_POLL_INTERVAL
  periodic() {
    _cmux_int_poll_tick
    (( ${+functions[_cmux_int_original_periodic]} )) && _cmux_int_original_periodic
  }
}

_cmux_int_stop_poller() {
  (( ! _cmux_int_poller_active )) && return

  _cmux_int_poller_active=0
  async_stop_worker cmux_poller 2>/dev/null

  # Restore original periodic function.
  if (( ${+functions[_cmux_int_original_periodic]} )); then
    functions[periodic]="${functions[_cmux_int_original_periodic]}"
    unfunction _cmux_int_original_periodic 2>/dev/null
  else
    unfunction periodic 2>/dev/null
    unset PERIOD
  fi
}

# ---------------------------------------------------------------------------
# Clear all cmux state from a previous repo context.
# ---------------------------------------------------------------------------
_cmux_int_clear_all() {
  _cmux_int_stop_poller

  [[ -n $_cmux_int_last_jira_pill ]]     && _cmux_int_clear_status "jira"
  [[ -n $_cmux_int_last_pr_pill ]]        && _cmux_int_clear_status "pr"
  [[ -n $_cmux_int_last_pipeline_pill ]]  && _cmux_int_clear_status "pipeline"
  [[ -n $_cmux_int_last_pipeline_progress ]] && _cmux_int_ws_cmd clear-progress

  _cmux_int_last_jira_pill=""
  _cmux_int_last_pr_pill=""
  _cmux_int_last_pipeline_pill=""
  _cmux_int_last_pipeline_progress=""
  _cmux_int_last_workspace_title=""
  _cmux_int_pipeline_status=""
  _cmux_int_workspace_id=""
}

# ---------------------------------------------------------------------------
# Apply current context: workspace title, pills, poller.
# Called after repo/branch detection or branch change.
# ---------------------------------------------------------------------------
_cmux_int_apply_context() {
  # Capture workspace ID for scoped cmux commands.
  _cmux_int_workspace_id="${CMUX_WORKSPACE_ID:-}"

  # Clear stale jira/pr pills if ticket or branch changed.
  if [[ -n $_cmux_int_last_jira_pill ]]; then
    _cmux_int_clear_status "jira"
    _cmux_int_last_jira_pill=""
  fi
  if [[ -n $_cmux_int_last_pr_pill ]]; then
    _cmux_int_clear_status "pr"
    _cmux_int_last_pr_pill=""
  fi
  if [[ -n $_cmux_int_last_pipeline_pill ]]; then
    _cmux_int_clear_status "pipeline"
    _cmux_int_last_pipeline_pill=""
  fi
  if [[ -n $_cmux_int_last_pipeline_progress ]]; then
    _cmux_int_ws_cmd clear-progress
    _cmux_int_last_pipeline_progress=""
  fi

  # Set workspace title.
  local ws_title
  if [[ -n $_cmux_int_ticket ]]; then
    local branch_desc="${_cmux_int_branch#*/}"       # Strip prefix (feature/, fix/, etc.)
    branch_desc="${branch_desc#${_cmux_int_ticket}-}" # Strip ticket from desc.
    branch_desc="${branch_desc//-/ }"                 # Dashes to spaces.
    ws_title="${_cmux_int_ticket} · ${branch_desc}"
  else
    ws_title="${_cmux_int_repo_name} · ${_cmux_int_branch}"
  fi

  if [[ $ws_title != $_cmux_int_last_workspace_title ]]; then
    _cmux_int_last_workspace_title="$ws_title"
    _cmux_int_ws_cmd rename-workspace "${ws_title:0:60}"
  fi

  # Reset poller timestamps to re-fetch for new context.
  _cmux_int_jira_last_fetch=0
  _cmux_int_pr_last_fetch=0
  _cmux_int_pipeline_last_fetch=0
  _cmux_int_pipeline_status=""

  # Start or restart background polling.
  _cmux_int_start_poller
}

# ---------------------------------------------------------------------------
# chpwd hook: detect repo, set workspace, start poller.
# ---------------------------------------------------------------------------
_cmux_int_chpwd() {
  local prev_root="$_cmux_int_repo_root"

  if ! _cmux_int_detect_repo; then
    # Left a repo.
    if [[ -n $prev_root ]]; then
      _cmux_int_clear_all
    fi
    return
  fi

  # Same repo, same branch — nothing to do.
  if [[ $_cmux_int_repo_root == $prev_root ]]; then
    local current_branch
    current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
    if [[ $current_branch == $_cmux_int_branch ]]; then
      return
    fi
    _cmux_int_branch="$current_branch"
    # Re-parse ticket.
    if [[ $_cmux_int_branch =~ '([A-Z]+-[0-9]+)' ]]; then
      _cmux_int_ticket="${match[1]}"
    else
      _cmux_int_ticket=""
    fi
  fi

  # If switching repos, clear old state.
  if [[ $_cmux_int_repo_root != $prev_root ]] && [[ -n $prev_root ]]; then
    _cmux_int_clear_all
  fi

  _cmux_int_apply_context
}

# ---------------------------------------------------------------------------
# preexec / precmd hooks: command timing + exit status.
# ---------------------------------------------------------------------------
_cmux_int_preexec() {
  _cmux_int_cmd_start=$EPOCHSECONDS
  _cmux_int_cmd_text="${1:0:80}"
}

_cmux_int_precmd() {
  local exit_code=$?

  # Long-running command notification.
  if (( _cmux_int_cmd_start > 0 )); then
    local elapsed=$(( EPOCHSECONDS - _cmux_int_cmd_start ))
    _cmux_int_cmd_start=0

    if (( elapsed >= CMUX_INT_CMD_THRESHOLD )); then
      local duration_text
      if (( elapsed >= 60 )); then
        duration_text="$(( elapsed / 60 ))m$(( elapsed % 60 ))s"
      else
        duration_text="${elapsed}s"
      fi

      {
        cmux notify --title "Done (${duration_text})" --body "${_cmux_int_cmd_text}" &>/dev/null
        cmux trigger-flash &>/dev/null
      } &!
    fi
  fi

  # Re-detect branch in case it changed (git checkout, etc.).
  if [[ -n $_cmux_int_repo_root ]]; then
    local current_branch
    current_branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")
    if [[ -n $current_branch ]] && [[ $current_branch != $_cmux_int_branch ]]; then
      _cmux_int_branch="$current_branch"
      if [[ $_cmux_int_branch =~ '([A-Z]+-[0-9]+)' ]]; then
        _cmux_int_ticket="${match[1]}"
      else
        _cmux_int_ticket=""
      fi
      # Update workspace title, pills, and poller for new branch.
      _cmux_int_apply_context
    fi
  fi
}

# ---------------------------------------------------------------------------
# On-demand commands.
# ---------------------------------------------------------------------------

# cmux-pr: PR management.
cmux-pr() {
  case "${1:-status}" in
    status)
      if [[ -z $_cmux_int_az_repo ]] || [[ -z $_cmux_int_branch ]]; then
        print "Not in an Azure DevOps repo or no branch detected."
        return 1
      fi
      print "Fetching PR for $_cmux_int_az_repo branch $_cmux_int_branch..."
      local result
      result=$(_cmux_int_fetch_pr "$_cmux_int_az_repo" "$_cmux_int_branch")
      if [[ $result == "none" ]]; then
        print "No active PR for this branch."
      else
        local pr_id title pr_status approvals
        pr_id="${result%%|*}"
        local rest="${result#*|}"
        title="${rest%%|*}"
        rest="${rest#*|}"
        pr_status="${rest%%|*}"
        approvals="${rest#*|}"
        print "PR #${pr_id}: ${title}"
        print "Status: ${pr_status} | Approvals: ${approvals}"
      fi
      ;;

    create)
      if [[ -z $_cmux_int_az_repo ]] || [[ -z $_cmux_int_branch ]]; then
        print "Not in an Azure DevOps repo or no branch detected."
        return 1
      fi

      local pr_title branch_desc
      branch_desc="${_cmux_int_branch#*/}"
      branch_desc="${branch_desc//-/ }"

      if [[ -n $_cmux_int_ticket ]]; then
        pr_title="${_cmux_int_ticket} | ${branch_desc#${_cmux_int_ticket} }"
      else
        pr_title="$branch_desc"
      fi

      local jira_url=""
      if [[ -n $_cmux_int_ticket ]]; then
        # Try to extract Jira base URL from the CLI config.
        local jira_server
        jira_server=$(rg -m1 -o 'server:\s*["\x27]?([^"\x27\s]+)' -r '$1' "$HOME/.config/.jira/.config.yml" 2>/dev/null)
        if [[ -n $jira_server ]]; then
          jira_url="${jira_server}/browse/${_cmux_int_ticket}"
        fi
      fi

      local pr_body=""
      if [[ -n $jira_url ]]; then
        pr_body="[Ticket](${jira_url})"
      fi

      print "Creating PR: $pr_title"
      print "Target: $_cmux_int_main_branch"
      [[ -n $jira_url ]] && print "Jira: $jira_url"

      az repos pr create \
        -r "$_cmux_int_az_repo" \
        -s "$_cmux_int_branch" \
        -t "$_cmux_int_main_branch" \
        --title "$pr_title" \
        --description "${pr_body:-"."}" \
        --open 2>&1

      # Trigger immediate PR fetch.
      _cmux_int_pr_last_fetch=0
      _cmux_int_poll_tick
      ;;

    *)
      print "Usage: cmux-pr [status|create]"
      ;;
  esac
}

# cmux-jira: Jira ticket management.
cmux-jira() {
  case "${1:-status}" in
    status)
      if [[ -z $_cmux_int_ticket ]]; then
        print "No Jira ticket detected in branch name."
        return 1
      fi
      print "Fetching ${_cmux_int_ticket}..."
      local result
      result=$(_cmux_int_fetch_jira "$_cmux_int_ticket")
      if [[ -z $result ]]; then
        print "Could not fetch ticket."
        return 1
      fi
      local ticket status summary
      ticket="${result%%|*}"
      local rest="${result#*|}"
      status="${rest%%|*}"
      summary="${rest#*|}"
      print "${ticket}: ${summary}"
      print "Status: ${status}"
      ;;

    transition)
      if [[ -z $_cmux_int_ticket ]]; then
        print "No Jira ticket detected in branch name."
        return 1
      fi
      local target_status="${2:-}"
      if [[ -z $target_status ]]; then
        print "Usage: cmux-jira transition <status>"
        print "Example: cmux-jira transition \"In Review\""
        return 1
      fi
      print "Transitioning ${_cmux_int_ticket} to '${target_status}'..."
      jira issue move "$_cmux_int_ticket" "$target_status" 2>&1
      # Refresh Jira data.
      _cmux_int_jira_last_fetch=0
      _cmux_int_poll_tick
      ;;

    open)
      if [[ -z $_cmux_int_ticket ]]; then
        print "No Jira ticket detected in branch name."
        return 1
      fi
      jira open "$_cmux_int_ticket" 2>&1
      ;;

    *)
      print "Usage: cmux-jira [status|transition <status>|open]"
      ;;
  esac
}

# cmux-pipeline: Pipeline status.
cmux-pipeline() {
  case "${1:-status}" in
    status)
      if [[ -z $_cmux_int_az_repo ]] || [[ -z $_cmux_int_branch ]]; then
        print "Not in an Azure DevOps repo or no branch detected."
        return 1
      fi
      print "Fetching pipeline for $_cmux_int_az_repo branch $_cmux_int_branch..."
      local result
      result=$(_cmux_int_fetch_pipeline "$_cmux_int_az_repo" "$_cmux_int_branch")
      if [[ $result == "none" ]]; then
        print "No pipeline runs for this branch."
      else
        local run_id run_status run_result pipeline_name job_progress
        run_id="${result%%|*}"
        local rest="${result#*|}"
        run_status="${rest%%|*}"
        rest="${rest#*|}"
        run_result="${rest%%|*}"
        rest="${rest#*|}"
        pipeline_name="${rest%%|*}"
        job_progress="${rest#*|}"
        print "Pipeline: ${pipeline_name} (#${run_id})"
        print "Status: ${run_status}${run_result:+ (${run_result})}"
        [[ $run_status == "inProgress" ]] && print "Jobs: ${job_progress}"
      fi
      ;;

    *)
      print "Usage: cmux-pipeline [status]"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Tab completions.
# ---------------------------------------------------------------------------
_cmux_pr_completion() {
  local -a subcmds=('status:Show PR status for current branch' 'create:Create a PR with Jira-linked title')
  _describe 'command' subcmds
}
compdef _cmux_pr_completion cmux-pr

_cmux_jira_completion() {
  local -a subcmds=('status:Show Jira ticket info' 'transition:Transition ticket to a status' 'open:Open ticket in browser')
  _describe 'command' subcmds
}
compdef _cmux_jira_completion cmux-jira

_cmux_pipeline_completion() {
  local -a subcmds=('status:Show pipeline status')
  _describe 'command' subcmds
}
compdef _cmux_pipeline_completion cmux-pipeline

# ---------------------------------------------------------------------------
# Register hooks.
# ---------------------------------------------------------------------------
autoload -Uz add-zsh-hook
add-zsh-hook chpwd  _cmux_int_chpwd
add-zsh-hook preexec _cmux_int_preexec
add-zsh-hook precmd  _cmux_int_precmd

# ---------------------------------------------------------------------------
# Cleanup on shell exit.
# ---------------------------------------------------------------------------
_cmux_int_zshexit() {
  _cmux_int_clear_all
}
add-zsh-hook zshexit _cmux_int_zshexit

# ---------------------------------------------------------------------------
# Initial detection (for the directory the shell started in).
# ---------------------------------------------------------------------------
_cmux_int_chpwd
