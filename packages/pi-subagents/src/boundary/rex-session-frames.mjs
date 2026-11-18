// @ts-check

/**
 * The wire shared by the three ends of a Rex-hosted subagent: the launcher the root spawns, the
 * child half inside the interactive Pi, and the root's own socket for parked sessions. A frame is
 * one line: a kind character, then JSON.
 */

/** Names the launcher's socket to the child, which reads both once and removes them. */
export const REX_SOCKET_ENV = "PI_SUBAGENT_REX_SOCKET";
export const REX_TOKEN_ENV = "PI_SUBAGENT_REX_TOKEN";

/** A silent candidate or stalled presenter cannot retain ambiguous ownership indefinitely. */
export const REX_HANDOFF_TIMEOUT_MS = 5_000;

export const REX_FRAME = Object.freeze({
  /** The child names itself to the end it connected to: `{ token, pid, parked }`. */
  hello: "H",
  /** The receiver authenticated the hello: `{ ok: true }`. Only now may the child switch. */
  accept: "K",
  /** A backend command, response, or event, as a headless child's RPC channel carries them. */
  rpc: "R",
  /** A parent-contact message, as a headless child's process IPC carries them. */
  contact: "C",
  /** Tells the child to wait on the root's socket: `{ socket, token }`; answered `{ ok }`. */
  park: "P",
  /** Tells a parked child to serve a new launcher: `{ socket, token }`. */
  adopt: "A",
  /** Words to show the user in the child's own session: `{ message }`. */
  notice: "N",
  /** What the user typed into a parked session: `{ text }`. */
  resume: "U",
  /** The user asked, inside the session, to hide its pane: `{ ok }`. */
  hide: "D",
  /**
   * A questionnaire for the user, shown in the child's own session: `{ id, request }`, taken back
   * with `{ id, withdraw }`, acknowledged only after presenter settlement. The child answers `{ id, shown }` once it is on screen, then
   * `{ id, outcome }`, or `{ id, declined }` when it could not show it or stopped showing it.
   */
  ask: "Q",
});

/** How the root hands its launcher an `ask` frame for the child: `{ type, ask }` over process IPC. */
export const REX_ASK_MESSAGE = "pi_subagents_rex_ask";
/** How the launcher hands the root the child's `ask` frames: `{ type, answer }` on stdout. */
export const REX_ANSWER_NOTE = "pi_subagents_rex_answer";

/**
 * @param {string} kind
 * @param {unknown} value
 * @returns {string}
 */
export const rexFrame = (kind, value) => `${kind}${JSON.stringify(value)}\n`;

/**
 * Splits buffered text into whole frames and the unfinished rest.
 * @param {string} text
 * @returns {{ frames: Array<{ kind: string, body: string }>, rest: string }}
 */
export const splitRexFrames = (text) => {
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";
  return {
    frames: lines
      .filter((line) => line.length > 0)
      .map((line) => ({ kind: line[0] ?? "", body: line.slice(1) })),
    rest,
  };
};
