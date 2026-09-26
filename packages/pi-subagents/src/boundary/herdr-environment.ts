// One bounded ambient Herdr/native environment snapshot is captured at the Node boundary.
import { pickEnvironment } from "./harness-shared.ts";

/** Keys inherited by Herdr CLI commands and native readiness probes. */
export const HERDR_CLI_ENVIRONMENT_KEYS =
  "HOME USER LOGNAME PATH SHELL TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE XDG_CONFIG_HOME XDG_STATE_HOME HERDR_CONFIG_PATH HERDR_SOCKET_PATH HERDR_SESSION HERDR_ENV HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID PI_CODING_AGENT_DIR PI_CONFIG_DIR CLAUDE_CONFIG_DIR CODEX_HOME".split(
    " ",
  );

/** Keys a private Herdr harness forwards into its sterile pane environment. */
export const HERDR_HARNESS_ENVIRONMENT_KEYS =
  "HOME USER LOGNAME PATH SHELL TMPDIR TMP TEMP LANG LC_ALL LC_CTYPE TERM COLORTERM SSL_CERT_FILE SSL_CERT_DIR XDG_CONFIG_HOME XDG_STATE_HOME HERDR_CONFIG_PATH HERDR_SOCKET_PATH HERDR_SESSION PI_CODING_AGENT_DIR PI_CONFIG_DIR CLAUDE_CONFIG_DIR".split(
    " ",
  );

const CAPTURED_HERDR_ENVIRONMENT_KEYS = [
  ...new Set([
    ...HERDR_CLI_ENVIRONMENT_KEYS,
    ...HERDR_HARNESS_ENVIRONMENT_KEYS,
    "CODEX_HOME",
    "OPENAI_API_KEY",
  ]),
];

/**
 * Clone the complete bounded union needed by Herdr CLI and native harness services once.
 * Each service still applies its narrower allowlist, but cannot observe a different ambient value.
 */
export const captureHerdrEnvironment = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => pickEnvironment(source, CAPTURED_HERDR_ENVIRONMENT_KEYS);
