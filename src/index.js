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

async function safeRun(commandPromise) {
  await commandPromise.quiet().catch(() => {});
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

export const OpencodeCmuxPlugin = async ({ $ }) => {
  if (!(await hasCmux($))) return {};

  const busySessions = new Set();
  const pendingPermissions = new Map();
  const pendingQuestions = new Map();

  async function onPermissionRequested(properties) {
    const requestID = eventRequestID(properties);
    const sessionID = eventSessionID({ properties });
    const isNew = setPendingRequest(pendingPermissions, requestID, sessionID);
    if (!isNew) return;

    await setWaitingStatus($);
    await safeRun(
      $`cmux notify --title "OpenCode" --subtitle "Needs permission" --body ${permissionLabel(properties)}`,
    );
  }

  async function onQuestionAsked(properties) {
    const requestID = eventRequestID(properties);
    const sessionID = eventSessionID({ properties });
    const isNew = setPendingRequest(pendingQuestions, requestID, sessionID);
    if (!isNew) return;

    await setQuestionStatus($);
    await safeRun(
      $`cmux notify --title "OpenCode" --subtitle "Has a question" --body ${questionLabel(properties)}`,
    );
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

      if (event.type === "session.idle") {
        const sessionID = eventSessionID(event);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);

        if (hasPendingInput(pendingPermissions, pendingQuestions)) {
          return;
        }

        await safeRun($`cmux notify --title "OpenCode" --body "Session complete"`);
        return;
      }

      if (event.type === "session.error") {
        const sessionID = eventSessionID(event);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();

        clearPendingRequestsBySession(pendingPermissions, sessionID);
        clearPendingRequestsBySession(pendingQuestions, sessionID);

        await restoreStatus($, busySessions, pendingPermissions, pendingQuestions);
        await safeRun($`cmux notify --title "OpenCode" --body "Session errored"`);
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
      }
    },
  };
};

export const CmuxNotifyPlugin = OpencodeCmuxPlugin;
export default OpencodeCmuxPlugin;
