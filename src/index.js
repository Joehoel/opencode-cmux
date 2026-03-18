/**
 * OpenCode plugin: cmux notifications + sidebar status.
 *
 * This plugin uses sensible built-in defaults and does not require
 * any environment-variable configuration.
 */

const STATUS_KEY = "opencode";
const LOG_SOURCE = "opencode";
const DEFAULT_WORKSPACE_KEY = "__current_workspace__";

const STATUS_WORKING = { text: "working", icon: "bolt", color: "#007aff" };
const STATUS_WAITING = { text: "waiting", icon: "lock", color: "#ef4444" };
const STATUS_QUESTION = { text: "question", icon: "help-circle", color: "#a855f7" };

async function safeRun(commandPromise) {
  await commandPromise.quiet().catch(() => {});
}

function appendWorkspace(args, workspaceID) {
  if (workspaceID) args.push("--workspace", workspaceID);
  return args;
}

function workspaceKey(workspaceID) {
  return workspaceID ?? DEFAULT_WORKSPACE_KEY;
}

async function cmuxLog($, level, message, workspaceID) {
  const args = appendWorkspace(["--level", level, "--source", LOG_SOURCE], workspaceID);
  args.push("--", message);
  await safeRun($`cmux log ${args}`);
}

async function cmuxNotify($, { title, subtitle, body, workspaceID }) {
  const args = ["--title", title];
  if (subtitle) args.push("--subtitle", subtitle);
  if (body) args.push("--body", body);
  appendWorkspace(args, workspaceID);
  await safeRun($`cmux notify ${args}`);
}

async function setProgress($, ratio, label, workspaceID) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const normalized = Number(clamped.toFixed(2));
  const args = [String(normalized)];
  if (label) args.push("--label", label);
  appendWorkspace(args, workspaceID);
  await safeRun($`cmux set-progress ${args}`);
}

async function clearProgress($, workspaceID) {
  const args = appendWorkspace([], workspaceID);
  await safeRun($`cmux clear-progress ${args}`);
}

async function workspaceAction($, action, workspaceID) {
  const args = appendWorkspace(["--action", action], workspaceID);
  await safeRun($`cmux workspace-action ${args}`);
}

async function triggerFlash($, workspaceID) {
  const args = appendWorkspace([], workspaceID);
  await safeRun($`cmux trigger-flash ${args}`);
}

async function hasCmux($) {
  try {
    await $`command -v cmux`.quiet();
  } catch {
    return false;
  }

  try {
    await $`cmux ping`.quiet();
    return true;
  } catch {
    return false;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function truncate(value, max = 180) {
  const text = stringValue(value);
  if (!text) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function pluralize(word, count) {
  return count === 1 ? word : `${word}s`;
}

function eventSessionID(event) {
  return event?.properties?.sessionID;
}

function eventIsBusy(event) {
  return event?.type === "session.status" && event?.properties?.status?.type === "busy";
}

function eventIsRetry(event) {
  return event?.type === "session.status" && event?.properties?.status?.type === "retry";
}

function eventRequestID(source) {
  return (
    stringValue(source?.id) ??
    stringValue(source?.requestID) ??
    stringValue(source?.permissionID)
  );
}

function requestKey(prefix, properties) {
  return eventRequestID(properties) ?? (() => {
    const sessionID = stringValue(properties?.sessionID);
    return sessionID ? `${prefix}:${sessionID}` : undefined;
  })();
}

function setPendingRequest(requests, key, sessionID) {
  if (!key) return true;
  if (requests.has(key)) return false;
  requests.set(key, sessionID ?? "");
  return true;
}

function clearPendingRequest(requests, key) {
  if (!key) return false;
  return requests.delete(key);
}

function clearPendingRequestsBySession(requests, sessionID) {
  if (!sessionID) return;
  for (const [key, requestSessionID] of requests.entries()) {
    if (requestSessionID === sessionID) {
      requests.delete(key);
    }
  }
}

function formatSummary(summary) {
  if (!summary || typeof summary !== "object") return undefined;

  const files = typeof summary.files === "number" ? summary.files : undefined;
  const additions = typeof summary.additions === "number" ? summary.additions : undefined;
  const deletions = typeof summary.deletions === "number" ? summary.deletions : undefined;

  const fileText = files !== undefined ? `${files} ${pluralize("file", files)} changed` : undefined;
  const diffText =
    additions !== undefined || deletions !== undefined
      ? `(+${additions ?? 0}/-${deletions ?? 0})`
      : undefined;

  return [fileText, diffText].filter(Boolean).join(" ") || undefined;
}

function metadataHint(properties) {
  const metadata = properties?.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;

  return (
    stringValue(metadata.command) ??
    stringValue(metadata.cmd) ??
    stringValue(metadata.title) ??
    stringValue(metadata.reason)
  );
}

function formatPermissionDetail(properties) {
  const permission =
    stringValue(properties?.permission) ??
    stringValue(properties?.title) ??
    stringValue(properties?.type) ??
    "Command approval required";

  const hint = metadataHint(properties);
  if (hint) {
    return truncate(`${permission}: ${hint}`);
  }

  const patterns = Array.isArray(properties?.patterns)
    ? properties.patterns.map(stringValue).filter(Boolean)
    : [];

  if (patterns.length > 0) {
    const preview = patterns.slice(0, 2).join(", ");
    const suffix = patterns.length > 2 ? ", ..." : "";
    return truncate(`${permission} (scope ${preview}${suffix})`);
  }

  return truncate(permission);
}

function formatQuestionDetail(properties) {
  const first = Array.isArray(properties?.questions) ? properties.questions[0] : undefined;
  const header = truncate(stringValue(first?.header) ?? "Question", 80);
  const question = stringValue(first?.question);
  const optionCount = Array.isArray(first?.options) ? first.options.length : 0;
  const optionText = optionCount > 0 ? `${optionCount} ${pluralize("option", optionCount)}` : undefined;

  const body = question
    ? truncate(optionText ? `${question} (${optionText})` : question)
    : optionText;

  return {
    header,
    body: body ?? header,
  };
}

function formatErrorDetail(error) {
  const name = stringValue(error?.name);
  const message =
    stringValue(error?.data?.message) ??
    stringValue(error?.message) ??
    "Check OpenCode output for details.";
  const statusCode = Number.isFinite(error?.data?.statusCode)
    ? `HTTP ${error.data.statusCode}`
    : undefined;

  const subtitle = truncate([name, statusCode].filter(Boolean).join(" · ") || "Session errored", 120);

  return {
    subtitle,
    body: truncate(message),
  };
}

async function setStatus($, status, workspaceID) {
  const args = appendWorkspace(
    [STATUS_KEY, status.text, "--icon", status.icon, "--color", status.color],
    workspaceID,
  );
  await safeRun($`cmux set-status ${args}`);
}

async function clearStatus($, workspaceID) {
  const args = appendWorkspace([STATUS_KEY], workspaceID);
  await safeRun($`cmux clear-status ${args}`);
}

async function setWorkingStatus($, workspaceID) {
  await setStatus($, STATUS_WORKING, workspaceID);
}

async function setWaitingStatus($, workspaceID) {
  await setStatus($, STATUS_WAITING, workspaceID);
}

async function setQuestionStatus($, workspaceID) {
  await setStatus($, STATUS_QUESTION, workspaceID);
}

export const OpencodeCmuxPlugin = async ({ $, client }) => {
  if (!(await hasCmux($))) return {};

  const busySessions = new Set();
  const pendingPermissions = new Map();
  const pendingQuestions = new Map();
  const sessionInfoCache = new Map();
  const sessionWorkspaceByID = new Map();
  const progressStateByWorkspace = new Map();
  const unreadWorkspaces = new Set();

  function workspaceForSession(sessionID) {
    if (!sessionID) return undefined;
    return sessionWorkspaceByID.get(sessionID);
  }

  function sessionBelongsToWorkspace(sessionID, workspaceID) {
    const sessionWorkspaceID = workspaceForSession(sessionID);
    if (workspaceID) return sessionWorkspaceID === workspaceID;
    return sessionWorkspaceID === undefined;
  }

  function countBusyInWorkspace(workspaceID) {
    let count = 0;
    for (const sessionID of busySessions) {
      if (sessionBelongsToWorkspace(sessionID, workspaceID)) count += 1;
    }
    return count;
  }

  function countPendingInWorkspace(requests, workspaceID) {
    let count = 0;
    for (const sessionID of requests.values()) {
      if (sessionBelongsToWorkspace(sessionID, workspaceID)) count += 1;
    }
    return count;
  }

  function hasPendingInputInWorkspace(workspaceID) {
    return (
      countPendingInWorkspace(pendingPermissions, workspaceID) > 0 ||
      countPendingInWorkspace(pendingQuestions, workspaceID) > 0
    );
  }

  async function restoreStatusForWorkspace(workspaceID) {
    if (countPendingInWorkspace(pendingQuestions, workspaceID) > 0) {
      await setQuestionStatus($, workspaceID);
      return;
    }

    if (countPendingInWorkspace(pendingPermissions, workspaceID) > 0) {
      await setWaitingStatus($, workspaceID);
      return;
    }

    if (countBusyInWorkspace(workspaceID) > 0) {
      await setWorkingStatus($, workspaceID);
      return;
    }

    await clearStatus($, workspaceID);
  }

  async function clearProgressForWorkspace(workspaceID) {
    const key = workspaceKey(workspaceID);
    if (!progressStateByWorkspace.has(key)) return;
    await clearProgress($, workspaceID);
    progressStateByWorkspace.delete(key);
  }

  async function updateProgressForWorkspace(workspaceID, todos) {
    const key = workspaceKey(workspaceID);
    const total = todos.length;

    if (total === 0) {
      await clearProgressForWorkspace(workspaceID);
      return;
    }

    const completed = todos.filter((todo) => todo?.status === "completed").length;
    const active = todos.filter((todo) => todo?.status === "in_progress").length;
    const ratio = completed / total;
    const label = `Tasks ${completed}/${total}${active > 0 ? ` · ${active} active` : ""}`;

    const previous = progressStateByWorkspace.get(key);
    if (previous && previous.label === label && Math.abs(previous.ratio - ratio) < 0.01) {
      return;
    }

    await setProgress($, ratio, label, workspaceID);
    progressStateByWorkspace.set(key, { ratio, label });
  }

  async function markWorkspaceUnread(workspaceID, { flash = false } = {}) {
    const key = workspaceKey(workspaceID);
    if (!unreadWorkspaces.has(key)) {
      await workspaceAction($, "mark-unread", workspaceID);
      unreadWorkspaces.add(key);
    }

    if (flash) {
      await triggerFlash($, workspaceID);
    }
  }

  async function markWorkspaceRead(workspaceID) {
    const key = workspaceKey(workspaceID);
    if (!unreadWorkspaces.has(key)) return;
    await workspaceAction($, "mark-read", workspaceID);
    unreadWorkspaces.delete(key);
  }

  async function fetchSessionInfo(sessionID) {
    if (!sessionID) return null;
    if (sessionInfoCache.has(sessionID)) return sessionInfoCache.get(sessionID);

    if (!client?.session?.get) {
      return null;
    }

    try {
      const result = await client.session.get({ path: { id: sessionID } });
      const data = result?.data;
      if (!data) return null;

      const workspaceID = stringValue(data.workspaceID);
      const info = {
        title: truncate(stringValue(data.title) ?? sessionID, 90),
        isSubagent: stringValue(data.parentID) !== undefined,
        summary: formatSummary(data.summary),
        workspaceID,
      };

      sessionInfoCache.set(sessionID, info);
      sessionWorkspaceByID.set(sessionID, workspaceID);
      return info;
    } catch {
      return null;
    }
  }

  async function onTodoUpdated(properties) {
    const sessionID = stringValue(properties?.sessionID);
    if (!sessionID) return;

    const sessionInfo = await fetchSessionInfo(sessionID);
    const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);
    const todos = Array.isArray(properties?.todos) ? properties.todos : [];
    await updateProgressForWorkspace(workspaceID, todos);
  }

  async function onPermissionRequested(properties) {
    const sessionID = stringValue(properties?.sessionID);
    const key = requestKey("permission", properties);
    const isNew = setPendingRequest(pendingPermissions, key, sessionID);
    if (!isNew) return;

    const sessionInfo = await fetchSessionInfo(sessionID);
    const sessionLabel = sessionInfo?.title ?? sessionID ?? "OpenCode session";
    const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);
    const detail = formatPermissionDetail(properties);

    await setWaitingStatus($, workspaceID);
    await cmuxNotify($, {
      title: "Needs your permission",
      subtitle: sessionLabel,
      body: detail,
      workspaceID,
    });
    await cmuxLog($, "info", `Permission requested in ${sessionLabel}: ${detail}`, workspaceID);
    await markWorkspaceUnread(workspaceID, { flash: true });
  }

  async function onQuestionAsked(properties) {
    const sessionID = stringValue(properties?.sessionID);
    const key = requestKey("question", properties);
    const isNew = setPendingRequest(pendingQuestions, key, sessionID);
    if (!isNew) return;

    const sessionInfo = await fetchSessionInfo(sessionID);
    const sessionLabel = sessionInfo?.title ?? sessionID ?? "OpenCode session";
    const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);
    const question = formatQuestionDetail(properties);

    await setQuestionStatus($, workspaceID);
    await cmuxNotify($, {
      title: "Has a question",
      subtitle: `${sessionLabel} · ${question.header}`,
      body: question.body,
      workspaceID,
    });
    await cmuxLog($, "info", `Question in ${sessionLabel}: ${question.header}`, workspaceID);
    await markWorkspaceUnread(workspaceID, { flash: true });
  }

  return {
    "permission.ask": async (input) => {
      await onPermissionRequested(input);
    },

    event: async ({ event }) => {
      if (eventIsBusy(event)) {
        const sessionID = eventSessionID(event);
        const sessionInfo = await fetchSessionInfo(sessionID);
        const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);
        const wasBusy = countBusyInWorkspace(workspaceID) > 0;
        if (sessionID) busySessions.add(sessionID);

        if (!wasBusy && !hasPendingInputInWorkspace(workspaceID)) {
          await setWorkingStatus($, workspaceID);
        }

        if (!hasPendingInputInWorkspace(workspaceID)) {
          await markWorkspaceRead(workspaceID);
        }
        return;
      }

      if (eventIsRetry(event)) {
        const sessionID = eventSessionID(event) ?? "session";
        const sessionInfo = await fetchSessionInfo(sessionID);
        const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);
        const attempt = event?.properties?.status?.attempt;
        const message = stringValue(event?.properties?.status?.message);
        const detail = [
          `Retrying ${sessionID}`,
          typeof attempt === "number" ? `(attempt ${attempt})` : undefined,
          message ? `: ${message}` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        await cmuxLog($, "warning", detail, workspaceID);
        return;
      }

      if (event.type === "todo.updated") {
        await onTodoUpdated(event.properties);
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = eventSessionID(event);
        const sessionInfo = await fetchSessionInfo(sessionID);
        const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();

        await restoreStatusForWorkspace(workspaceID);

        if (countBusyInWorkspace(workspaceID) === 0) {
          await clearProgressForWorkspace(workspaceID);
        }

        if (hasPendingInputInWorkspace(workspaceID)) {
          return;
        }

        const label = sessionInfo?.title ?? sessionID ?? "session";
        const summary = sessionInfo?.summary;

        if (sessionInfo?.isSubagent) {
          await cmuxLog(
            $,
            "info",
            summary ? `Subagent finished: ${label} (${summary})` : `Subagent finished: ${label}`,
            workspaceID,
          );
          return;
        }

        await cmuxNotify($, {
          title: `Done: ${label}`,
          subtitle: summary ?? "Session complete",
          body: "OpenCode is idle and waiting for your next prompt.",
          workspaceID,
        });
        await cmuxLog(
          $,
          "success",
          summary ? `Done: ${label} (${summary})` : `Done: ${label}`,
          workspaceID,
        );
        return;
      }

      if (event.type === "session.error") {
        const sessionID = eventSessionID(event);
        const sessionInfo = await fetchSessionInfo(sessionID);
        const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();

        clearPendingRequestsBySession(pendingPermissions, sessionID);
        clearPendingRequestsBySession(pendingQuestions, sessionID);

        await restoreStatusForWorkspace(workspaceID);

        if (countBusyInWorkspace(workspaceID) === 0) {
          await clearProgressForWorkspace(workspaceID);
        }

        const label = sessionInfo?.title ?? sessionID ?? "session";
        const detail = formatErrorDetail(event?.properties?.error);

        await cmuxNotify($, {
          title: `Error: ${label}`,
          subtitle: detail.subtitle,
          body: detail.body,
          workspaceID,
        });
        await cmuxLog($, "error", `Error in ${label}: ${detail.body}`, workspaceID);
        await markWorkspaceUnread(workspaceID, { flash: true });
        return;
      }

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        await onPermissionRequested(event.properties);
        return;
      }

      if (event.type === "permission.replied") {
        const key = requestKey("permission", event.properties);
        const sessionID = eventSessionID(event);
        const sessionInfo = await fetchSessionInfo(sessionID);
        const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);

        const removed = clearPendingRequest(pendingPermissions, key);
        if (!removed && sessionID) {
          clearPendingRequestsBySession(pendingPermissions, sessionID);
        }

        await restoreStatusForWorkspace(workspaceID);

        if (!hasPendingInputInWorkspace(workspaceID) && countBusyInWorkspace(workspaceID) > 0) {
          await markWorkspaceRead(workspaceID);
        }

        const label = sessionInfo?.title ?? sessionID ?? "session";
        await cmuxLog($, "info", `Permission resolved in ${label}`, workspaceID);
        return;
      }

      if (event.type === "question.asked") {
        await onQuestionAsked(event.properties);
        return;
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        const key = requestKey("question", event.properties);
        const sessionID = eventSessionID(event);
        const sessionInfo = await fetchSessionInfo(sessionID);
        const workspaceID = sessionInfo?.workspaceID ?? workspaceForSession(sessionID);

        const removed = clearPendingRequest(pendingQuestions, key);
        if (!removed && sessionID) {
          clearPendingRequestsBySession(pendingQuestions, sessionID);
        }

        await restoreStatusForWorkspace(workspaceID);

        if (!hasPendingInputInWorkspace(workspaceID) && countBusyInWorkspace(workspaceID) > 0) {
          await markWorkspaceRead(workspaceID);
        }

        const label = sessionInfo?.title ?? sessionID ?? "session";
        await cmuxLog($, "info", `Question resolved in ${label}`, workspaceID);
      }
    },
  };
};

export const CmuxNotifyPlugin = OpencodeCmuxPlugin;
export default OpencodeCmuxPlugin;
