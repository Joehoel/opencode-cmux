/**
 * OpenCode plugin: cmux notifications + sidebar status.
 *
 * Environment overrides:
 * - CMUX_STATUS_KEY (default: opencode)
 * - CMUX_STATUS_TEXT (default: working)
 * - CMUX_STATUS_ICON (default: bolt)
 * - CMUX_STATUS_COLOR (default: #007aff)
 * - CMUX_WAITING_STATUS_TEXT (default: waiting)
 * - CMUX_WAITING_STATUS_ICON (default: lock)
 * - CMUX_WAITING_STATUS_COLOR (default: #ef4444)
 * - CMUX_QUESTION_STATUS_TEXT (default: question)
 * - CMUX_QUESTION_STATUS_ICON (default: help-circle)
 * - CMUX_QUESTION_STATUS_COLOR (default: #a855f7)
 * - CMUX_LOG_SOURCE (default: opencode)
 * - CMUX_LOG_ENABLED (default: true)
 * - CMUX_LOG_VERBOSITY (default: normal; values: silent, errors, normal, verbose)
 */

const STATUS_KEY = process.env.CMUX_STATUS_KEY ?? "opencode";
const STATUS_TEXT = process.env.CMUX_STATUS_TEXT ?? "working";
const STATUS_ICON = process.env.CMUX_STATUS_ICON ?? "bolt";
const STATUS_COLOR = process.env.CMUX_STATUS_COLOR ?? "#007aff";
const WAITING_STATUS_TEXT = process.env.CMUX_WAITING_STATUS_TEXT ?? "waiting";
const WAITING_STATUS_ICON = process.env.CMUX_WAITING_STATUS_ICON ?? "lock";
const WAITING_STATUS_COLOR = process.env.CMUX_WAITING_STATUS_COLOR ?? "#ef4444";
const QUESTION_STATUS_TEXT = process.env.CMUX_QUESTION_STATUS_TEXT ?? "question";
const QUESTION_STATUS_ICON = process.env.CMUX_QUESTION_STATUS_ICON ?? "help-circle";
const QUESTION_STATUS_COLOR = process.env.CMUX_QUESTION_STATUS_COLOR ?? "#a855f7";
const LOG_SOURCE = process.env.CMUX_LOG_SOURCE ?? "opencode";
const LOG_ENABLED = parseBoolean(process.env.CMUX_LOG_ENABLED, true);
const LOG_VERBOSITY = parseLogVerbosity(process.env.CMUX_LOG_VERBOSITY);

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseLogVerbosity(value) {
  const normalized = String(value ?? "normal").trim().toLowerCase();
  if (["silent", "none", "off", "false", "0"].includes(normalized)) return "silent";
  if (["errors", "error"].includes(normalized)) return "errors";
  if (["verbose", "all", "debug"].includes(normalized)) return "verbose";
  return "normal";
}

function shouldLog(category) {
  if (!LOG_ENABLED) return false;
  if (LOG_VERBOSITY === "silent") return false;
  if (LOG_VERBOSITY === "errors") return category === "error";
  if (LOG_VERBOSITY === "normal") return category === "normal" || category === "error";
  return true;
}

async function safeRun(commandPromise) {
  await commandPromise.quiet().catch(() => {});
}

async function cmuxLog($, level, message, category = "normal") {
  if (!shouldLog(category)) return;
  await safeRun($`cmux log --level ${level} --source ${LOG_SOURCE} -- ${message}`);
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

function eventSessionID(event) {
  return event?.properties?.sessionID;
}

function eventIsBusy(event) {
  return event?.type === "session.status" && event?.properties?.status?.type === "busy";
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function eventRequestID(source) {
  return (
    stringValue(source?.id) ??
    stringValue(source?.requestID) ??
    stringValue(source?.permissionID)
  );
}

function permissionLabel(properties) {
  return (
    stringValue(properties?.title) ??
    stringValue(properties?.permission) ??
    stringValue(properties?.type) ??
    "A command requires approval"
  );
}

function questionLabel(properties) {
  const firstQuestion = Array.isArray(properties?.questions) ? properties.questions[0] : undefined;
  return stringValue(firstQuestion?.header) ?? "The agent has a question";
}

function setPendingRequest(requests, requestID, sessionID) {
  if (!requestID) return true;
  const isNew = !requests.has(requestID);
  requests.set(requestID, sessionID ?? "");
  return isNew;
}

function clearPendingRequest(requests, requestID) {
  if (!requestID) return false;
  return requests.delete(requestID);
}

function clearPendingRequestsBySession(requests, sessionID) {
  if (!sessionID) return;
  for (const [requestID, requestSessionID] of requests.entries()) {
    if (requestSessionID === sessionID) {
      requests.delete(requestID);
    }
  }
}

function hasPendingInput(permissionRequests, questionRequests) {
  return permissionRequests.size > 0 || questionRequests.size > 0;
}

async function setWorkingStatus($) {
  await safeRun(
    $`cmux set-status ${STATUS_KEY} ${STATUS_TEXT} --icon ${STATUS_ICON} --color ${STATUS_COLOR}`,
  );
}

async function setWaitingStatus($) {
  await safeRun(
    $`cmux set-status ${STATUS_KEY} ${WAITING_STATUS_TEXT} --icon ${WAITING_STATUS_ICON} --color ${WAITING_STATUS_COLOR}`,
  );
}

async function setQuestionStatus($) {
  await safeRun(
    $`cmux set-status ${STATUS_KEY} ${QUESTION_STATUS_TEXT} --icon ${QUESTION_STATUS_ICON} --color ${QUESTION_STATUS_COLOR}`,
  );
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

  async function fetchSessionInfo(sessionID) {
    if (!sessionID || !client?.session?.get) return null;

    try {
      const result = await client.session.get({ path: { id: sessionID } });
      const data = result?.data;
      if (!data) return null;

      return {
        title: stringValue(data.title) ?? sessionID,
        isSubagent: stringValue(data.parentID) !== undefined,
      };
    } catch {
      return null;
    }
  }

  async function onPermissionRequested(properties) {
    const requestID = eventRequestID(properties);
    const sessionID = eventSessionID({ properties });
    const isNew = setPendingRequest(pendingPermissions, requestID, sessionID);
    if (!isNew) return;

    const label = permissionLabel(properties);

    await setWaitingStatus($);
    await safeRun(
      $`cmux notify --title "OpenCode" --subtitle "Needs permission" --body ${label}`,
    );
    await cmuxLog($, "info", `Permission requested: ${label}`);
  }

  async function onQuestionAsked(properties) {
    const requestID = eventRequestID(properties);
    const sessionID = eventSessionID({ properties });
    const isNew = setPendingRequest(pendingQuestions, requestID, sessionID);
    if (!isNew) return;

    const label = questionLabel(properties);

    await setQuestionStatus($);
    await safeRun(
      $`cmux notify --title "OpenCode" --subtitle "Has a question" --body ${label}`,
    );
    await cmuxLog($, "info", `Question asked: ${label}`);
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
          await cmuxLog($, "progress", `Session busy: ${sessionID ?? "unknown"}`, "verbose");
        }
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = eventSessionID(event);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);

        if (hasPendingInput(pendingPermissions, pendingQuestions)) {
          await cmuxLog($, "progress", "Session idle while waiting for user input", "verbose");
          return;
        }

        const sessionInfo = await fetchSessionInfo(sessionID);
        const label = sessionInfo?.title ?? sessionID ?? "session";

        if (sessionInfo?.isSubagent) {
          await cmuxLog($, "info", `Subagent finished: ${label}`);
          return;
        }

        await safeRun($`cmux notify --title "OpenCode" --subtitle "Session complete" --body ${label}`);
        await cmuxLog($, "success", `Done: ${label}`);
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

        await safeRun($`cmux notify --title "OpenCode" --subtitle "Session errored" --body ${label}`);
        await cmuxLog($, "error", `Error in session: ${label}`, "error");
        return;
      }

      if (event.type === "permission.asked" || event.type === "permission.updated") {
        await onPermissionRequested(event.properties);
        return;
      }

      if (event.type === "permission.replied") {
        const requestID = eventRequestID(event.properties);
        const sessionID = eventSessionID(event);

        const removed = clearPendingRequest(pendingPermissions, requestID);
        if (!removed && sessionID) {
          clearPendingRequestsBySession(pendingPermissions, sessionID);
        }

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);
        await cmuxLog($, `progress`, `Permission resolved for session: ${sessionID ?? "unknown"}`, "verbose");
        return;
      }

      if (event.type === "question.asked") {
        await onQuestionAsked(event.properties);
        return;
      }

      if (event.type === "question.replied" || event.type === "question.rejected") {
        const requestID = eventRequestID(event.properties);
        const sessionID = eventSessionID(event);

        const removed = clearPendingRequest(pendingQuestions, requestID);
        if (!removed && sessionID) {
          clearPendingRequestsBySession(pendingQuestions, sessionID);
        }

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);
        await cmuxLog($, "progress", `Question resolved for session: ${sessionID ?? "unknown"}`, "verbose");
      }
    },
  };
};

export const CmuxNotifyPlugin = OpencodeCmuxPlugin;
export default OpencodeCmuxPlugin;
