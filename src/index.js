/**
 * OpenCode plugin: cmux notifications + sidebar status.
 *
 * Environment overrides:
 * - CMUX_STATUS_KEY (default: opencode)
 * - CMUX_STATUS_TEXT (default: working)
 * - CMUX_STATUS_ICON (default: bolt)
 * - CMUX_STATUS_COLOR (default: #007aff)
 */

const STATUS_KEY = process.env.CMUX_STATUS_KEY ?? "opencode";
const STATUS_TEXT = process.env.CMUX_STATUS_TEXT ?? "working";
const STATUS_ICON = process.env.CMUX_STATUS_ICON ?? "bolt";
const STATUS_COLOR = process.env.CMUX_STATUS_COLOR ?? "#007aff";

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

export const OpencodeCmuxPlugin = async ({ $ }) => {
  if (!(await hasCmux($))) return {};

  const busySessions = new Set();

  return {
    event: async ({ event }) => {
      if (eventIsBusy(event)) {
        const sessionID = eventSessionID(event);
        const wasEmpty = busySessions.size === 0;
        if (sessionID) busySessions.add(sessionID);

        if (wasEmpty) {
          await safeRun(
            $`cmux set-status ${STATUS_KEY} ${STATUS_TEXT} --icon ${STATUS_ICON} --color ${STATUS_COLOR}`,
          );
        }
        return;
      }

      if (event.type === "session.idle") {
        const sessionID = eventSessionID(event);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();
        if (busySessions.size === 0) {
          await safeRun($`cmux clear-status ${STATUS_KEY}`);
        }
        await safeRun($`cmux notify --title "OpenCode" --body "Session complete"`);
        return;
      }

      if (event.type === "session.error") {
        const sessionID = eventSessionID(event);
        if (sessionID) busySessions.delete(sessionID);
        else busySessions.clear();
        if (busySessions.size === 0) {
          await safeRun($`cmux clear-status ${STATUS_KEY}`);
        }
        await safeRun($`cmux notify --title "OpenCode" --body "Session errored"`);
      }
    },
  };
};

export const CmuxNotifyPlugin = OpencodeCmuxPlugin;
export default OpencodeCmuxPlugin;
