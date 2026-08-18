#!/usr/bin/env node
// Private Codex SessionStart compatibility hook. It adapts nullable transcript evidence for the
// marker-validated Herdr v7 integration and blocks the bootstrap turn before model inference.
import { spawnSync } from "node:child_process";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 4_096;
const STOP_OUTPUT = JSON.stringify({
  continue: false,
  stopReason: "Private Herdr lifecycle bootstrap completed.",
});

const integration = process.argv[2];
const fallbackTranscript = process.argv[3];
let chunks = [];
let length = 0;
for await (const value of process.stdin) {
  const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
  length += chunk.length;
  if (length > MAX_INPUT_BYTES) {
    chunks = [];
    break;
  }
  chunks.push(chunk);
}

let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  input = undefined;
}

const isString = (value) => value !== null && value !== undefined && value.constructor === String;
const safePath = (value) =>
  isString(value) &&
  value.startsWith("/") &&
  value.length > 0 &&
  value.length <= MAX_PATH_CHARS &&
  !/\p{Cc}/u.test(value);
const safeText = (value, maximum) =>
  isString(value) && value.length > 0 && value.length <= maximum && !/\p{Cc}/u.test(value);

if (
  input &&
  input !== null &&
  input !== undefined &&
  input.constructor === Object &&
  input.hook_event_name === "SessionStart" &&
  input.source === "startup" &&
  safeText(input.session_id, 256) &&
  safePath(integration) &&
  safePath(fallbackTranscript) &&
  safeText(process.env.HERDR_SOCKET_PATH, MAX_PATH_CHARS) &&
  safeText(process.env.HERDR_PANE_ID, 256)
) {
  const adapted = {
    ...input,
    transcript_path: safePath(input.transcript_path) ? input.transcript_path : fallbackTranscript,
  };
  spawnSync("/bin/bash", [integration, "session"], {
    env: process.env,
    input: `${JSON.stringify(adapted)}\n`,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 2_000,
    windowsHide: true,
  });
}

// Always stop the private bootstrap turn. If lifecycle reporting failed, the parent observes the
// missing atomic agent_session and fails closed without allowing the bootstrap prompt to infer.
process.stdout.write(`${STOP_OUTPUT}\n`);
