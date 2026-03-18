/**
 * OpenCode plugin: cmux notifications + sidebar status.
 *
 * This plugin uses sensible built-in defaults and does not require
 * any environment-variable configuration.
 */

const STATUS_KEY = "opencode";
const LOG_SOURCE = "opencode";

const STATUS_WORKING = { text: "working", icon: "bolt", color: "#007aff" };
const STATUS_WAITING = { text: "waiting", icon: "lock", color: "#ef4444" };
const STATUS_QUESTION = { text: "question", icon: "help-circle", color: "#a855f7" };

async function safeRun(commandPromise) {
  await commandPromise.quiet().catch(() => {});
}

async function cmuxLog($, level, message) {
  await safeRun($`cmux log --level ${level} --source ${LOG_SOURCE} -- ${message}`);
}

async function cmuxNotify($, { title, subtitle, body }) {
  const args = ["--title", title];
  if (subtitle) args.push("--subtitle", subtitle);
  if (body) args.push("--body", body);
  await safeRun($`cmux notify ${args}`);
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

function hasPendingInput(permissionRequests, questionRequests) {
  return permissionRequests.size > 0 || questionRequests.size > 0;
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

async function setStatus($, status) {
  await safeRun(
    $`cmux set-status ${STATUS_KEY} ${status.text} --icon ${status.icon} --color ${status.color}`,
  );
}

async function setWorkingStatus($) {
  await setStatus($, STATUS_WORKING);
}

async function setWaitingStatus($) {
  await setStatus($, STATUS_WAITING);
}

async function setQuestionStatus($) {
  await setStatus($, STATUS_QUESTION);
}

async function restoreStatus($, busySessions, pendingPermissions, pendingQuestions) {
  if (pendingQuestions.size > 0) {
    await setQuestionStatus($);
    return;
  }

  if (pendingPermissions.size > 0) {
    await setWaitingStatus($);
    return;
  }

  if (busySessions.size > 0) {
    await setWorkingStatus($);
    return;
  }

  await safeRun($`cmux clear-status ${STATUS_KEY}`);
}

export const OpencodeCmuxPlugin = async ({ $, client }) => {
  if (!(await hasCmux($))) return {};

  const busySessions = new Set();
  const pendingPermissions = new Map();
  const pendingQuestions = new Map();
  const sessionInfoCache = new Map();

  async function fetchSessionInfo(sessionID) {
    if (!sessionID || !client?.session?.get) return null;
    if (sessionInfoCache.has(sessionID)) return sessionInfoCache.get(sessionID);

    try {
      const result = await client.session.get({ path: { id: sessionID } });
      const data = result?.data;
      if (!data) return null;

      const info = {
        title: truncate(stringValue(data.title) ?? sessionID, 90),
        isSubagent: stringValue(data.parentID) !== undefined,
        summary: formatSummary(data.summary),
      };

      sessionInfoCache.set(sessionID, info);
      return info;
    } catch {
      return null;
    }
  }

  async function onPermissionRequested(properties) {
    const sessionID = stringValue(properties?.sessionID);
    const key = requestKey("permission", properties);
    const isNew = setPendingRequest(pendingPermissions, key, sessionID);
    if (!isNew) return;

    const sessionInfo = await fetchSessionInfo(sessionID);
    const sessionLabel = sessionInfo?.title ?? sessionID ?? "OpenCode session";
    const detail = formatPermissionDetail(properties);

    await setWaitingStatus($);
    await cmuxNotify($, {
      title: "Needs your permission",
      subtitle: sessionLabel,
      body: detail,
    });
    await cmuxLog($, "info", `Permission requested in ${sessionLabel}: ${detail}`);
  }

  async function onQuestionAsked(properties) {
    const sessionID = stringValue(properties?.sessionID);
    const key = requestKey("question", properties);
    const isNew = setPendingRequest(pendingQuestions, key, sessionID);
    if (!isNew) return;

    const sessionInfo = await fetchSessionInfo(sessionID);
    const sessionLabel = sessionInfo?.title ?? sessionID ?? "OpenCode session";
    const question = formatQuestionDetail(properties);

    await setQuestionStatus($);
    await cmuxNotify($, {
      title: "Has a question",
      subtitle: `${sessionLabel} · ${question.header}`,
      body: question.body,
    });
    await cmuxLog($, "info", `Question in ${sessionLabel}: ${question.header}`);
  }

  return {
    "permission.ask": async (input) => {
      await onPermissionRequested(input);
    },

    event: async ({ event }) => {
      if (eventIsBusy(event)) {
        const sessionID = eventSessionID(event);
        const wasEmpty = busySessions.size === 0;
        if (sessionID) busySessions.add(sessionID);

        if (wasEmpty && !hasPendingInput(pendingPermissions, pendingQuestions)) {
          await setWorkingStatus($);
        }
        return;
      }

      if (eventIsRetry(event)) {
        const sessionID = eventSessionID(event) ?? "session";
        const attempt = event?.properties?.status?.attempt;
        const message = stringValue(event?.properties?.status?.message);
        const detail = [
          `Retrying ${sessionID}`,
          typeof attempt === "number" ? `(attempt ${attempt})` : undefined,
          message ? `: ${message}` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        await cmuxLog($, "warning", detail);
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = eventSessionID(event);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);

        if (hasPendingInput(pendingPermissions, pendingQuestions)) {
          return;
        }

        const sessionInfo = await fetchSessionInfo(sessionID);
        const label = sessionInfo?.title ?? sessionID ?? "session";
        const summary = sessionInfo?.summary;

        if (sessionInfo?.isSubagent) {
          await cmuxLog(
            $, 
            "info",
            summary ? `Subagent finished: ${label} (${summary})` : `Subagent finished: ${label}`,
          );
          return;
        }

        await cmuxNotify($, {
          title: `Done: ${label}`,
          subtitle: summary ?? "Session complete",
          body: "OpenCode is idle and waiting for your next prompt.",
        });
        await cmuxLog($, "success", summary ? `Done: ${label} (${summary})` : `Done: ${label}`);
        return;
      }

      if (event.type === "session.error") {
        const sessionID = eventSessionID(event);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();

        clearPendingRequestsBySession(pendingPermissions, sessionID);
        clearPendingRequestsBySession(pendingQuestions, sessionID);

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);

        const sessionInfo = await fetchSessionInfo(sessionID);
        const label = sessionInfo?.title ?? sessionID ?? "session";
        const detail = formatErrorDetail(event?.properties?.error);

        await cmuxNotify($, {
          title: `Error: ${label}`,
          subtitle: detail.subtitle,
          body: detail.body,
        });
        await cmuxLog($, "error", `Error in ${label}: ${detail.body}`);
        return;
      }

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        await onPermissionRequested(event.properties);
        return;
      }

      if (event.type === "permission.replied") {
        const key = requestKey("permission", event.properties);
        const sessionID = eventSessionID(event);

        const removed = clearPendingRequest(pendingPermissions, key);
        if (!removed && sessionID) {
          clearPendingRequestsBySession(pendingPermissions, sessionID);
        }

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);

        const sessionInfo = await fetchSessionInfo(sessionID);
        const label = sessionInfo?.title ?? sessionID ?? "session";
        await cmuxLog($, "info", `Permission resolved in ${label}`);
        return;
      }

      if (event.type === "question.asked") {
        await onQuestionAsked(event.properties);
        return;
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        const key = requestKey("question", event.properties);
        const sessionID = eventSessionID(event);

        const removed = clearPendingRequest(pendingQuestions, key);
        if (!removed && sessionID) {
          clearPendingRequestsBySession(pendingQuestions, sessionID);
        }

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);

        const sessionInfo = await fetchSessionInfo(sessionID);
        const label = sessionInfo?.title ?? sessionID ?? "session";
        await cmuxLog($, "info", `Question resolved in ${label}`);
      }
    },
  };
};

export const CmuxNotifyPlugin = OpencodeCmuxPlugin;
export default OpencodeCmuxPlugin;
