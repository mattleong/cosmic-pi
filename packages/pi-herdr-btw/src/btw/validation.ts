import * as Effect from "effect/Effect";
import type {
  HerdrClientContract,
  HerdrPane,
  HerdrPaneProcessInfo,
} from "../boundary/herdr-client.ts";
import type { HerdrBtwSessionInput } from "../boundary/host-session.ts";
import type {
  SessionFileIdentityComparator,
  SessionFileIdentityComparison,
  SessionHeaderProbe,
} from "../boundary/session-file.ts";
import { HerdrBtwError } from "./errors.ts";
import { parseHerdrBtwSessionId } from "./marker.ts";

const MINIMUM_HERDR_PROTOCOL = 17;
const MAX_PROMPT_BYTES = 32 * 1024;
const SHELL_READINESS_ATTEMPTS = 31;
const SHELL_READINESS_DELAY_MILLIS = 200;
const REQUIRED_STABLE_SHELL_READINGS = 6;
const HERDR_SHELL_PROCESS_NAMES = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "elvish",
  "xonsh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
]);

/** Exact blank child identity from a valid, unparented session header. */
export const isValidBlankChildProbe = (
  probe: SessionHeaderProbe,
  childSessionId: string,
): boolean =>
  probe._tag === "valid" &&
  probe.header.id === childSessionId &&
  probe.header.parentSession === undefined;

export const ensureHerdrProtocol = (
  client: HerdrClientContract,
): Effect.Effect<void, HerdrBtwError> =>
  Effect.gen(function* () {
    const protocol = yield* client.inspectProtocol();
    if (protocol < MINIMUM_HERDR_PROTOCOL)
      return yield* new HerdrBtwError({
        operation: "inspect protocol",
        code: "herdr_upgrade_required",
        message: `Herdr protocol ${MINIMUM_HERDR_PROTOCOL} or newer is required; found ${protocol}.`,
        outcome: "confirmed",
      });
  });

export const ensurePiIntegration = (
  client: HerdrClientContract,
): Effect.Effect<void, HerdrBtwError> =>
  Effect.gen(function* () {
    if (!(yield* client.inspectPiIntegration()))
      return yield* new HerdrBtwError({
        operation: "inspect Pi integration",
        code: "herdr_pi_integration_unavailable",
        message:
          "The current Herdr Pi integration is required. Run `herdr integration install pi`, then try again.",
        outcome: "confirmed",
      });
  });

export const validateBtwInput = (
  prompt: string | undefined,
  input: HerdrBtwSessionInput,
  probeSessionHeader: (path: string) => SessionHeaderProbe,
): Effect.Effect<{ sessionFile: string; sessionId: string }, HerdrBtwError> =>
  Effect.gen(function* () {
    if (input.environment.HERDR_ENV !== "1" || !input.environment.HERDR_PANE_ID)
      return yield* new HerdrBtwError({
        operation: "validate environment",
        code: "herdr_environment_unavailable",
        message:
          "herdr-btw must run from a Pi session inside a Herdr-managed pane with caller identity.",
        outcome: "confirmed",
      });

    if (!input.sessionFile)
      return yield* new HerdrBtwError({
        operation: "validate parent session",
        code: "parent_session_unavailable",
        message:
          "The current Pi session does not have a readable persisted session file to reference.",
        outcome: "confirmed",
      });
    const sessionId = parseHerdrBtwSessionId(input.sessionId);
    if (sessionId === undefined)
      return yield* new HerdrBtwError({
        operation: "validate parent session",
        code: "parent_session_id_unavailable",
        message: "The current Pi session ID is unavailable or invalid.",
        outcome: "confirmed",
      });
    const parentProbe = probeSessionHeader(input.sessionFile);
    if (parentProbe._tag !== "valid")
      return yield* new HerdrBtwError({
        operation: "validate parent session",
        code: "parent_session_unavailable",
        message:
          "The current Pi session does not have a readable persisted session file to reference.",
        outcome: "confirmed",
      });
    if (parentProbe.header.id !== sessionId)
      return yield* new HerdrBtwError({
        operation: "validate parent session",
        code: "parent_session_owner_mismatch",
        message: "The parent session file header does not match the current Pi session identity.",
        outcome: "confirmed",
      });

    if (
      prompt !== undefined &&
      (prompt.includes("\0") || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
    )
      return yield* new HerdrBtwError({
        operation: "validate prompt",
        code: "btw_prompt_invalid",
        message: `The optional initial prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes and contain no NUL byte.`,
        outcome: "confirmed",
      });

    return { sessionFile: input.sessionFile, sessionId };
  });

const normalizedProcessName = (name: string): string =>
  (name.split(/[\\/]/gu).at(-1) ?? name)
    .replace(/^-+/gu, "")
    .replace(/\.exe$/giu, "")
    .toLowerCase();

const paneHasAvailableShell = (processInfo: HerdrPaneProcessInfo): boolean => {
  const shellPid = processInfo.shell_pid;
  const foregroundProcesses = processInfo.foreground_processes ?? [];
  const foregroundProcess = foregroundProcesses[0];
  return (
    shellPid !== null &&
    shellPid !== undefined &&
    processInfo.foreground_process_group_id === shellPid &&
    foregroundProcesses.length === 1 &&
    foregroundProcess?.pid === shellPid &&
    HERDR_SHELL_PROCESS_NAMES.has(normalizedProcessName(foregroundProcess.name))
  );
};

export const waitForAvailableShell = (
  client: HerdrClientContract,
  paneId: string,
): Effect.Effect<void, HerdrBtwError> =>
  Effect.gen(function* () {
    let stableReadings = 0;
    for (let attempt = 1; attempt <= SHELL_READINESS_ATTEMPTS; attempt += 1) {
      const processInfo = yield* client.inspectPaneProcessInfo(paneId);
      if (processInfo.pane_id !== paneId)
        return yield* new HerdrBtwError({
          operation: "inspect BTW pane shell",
          code: "herdr_btw_pane_shell_mismatch",
          message:
            "Herdr returned process information for a different pane. No Pi launch was attempted.",
          outcome: "confirmed",
        });
      stableReadings = paneHasAvailableShell(processInfo) ? stableReadings + 1 : 0;
      if (stableReadings >= REQUIRED_STABLE_SHELL_READINGS) return;
      if (attempt < SHELL_READINESS_ATTEMPTS) yield* Effect.sleep(SHELL_READINESS_DELAY_MILLIS);
    }

    return yield* new HerdrBtwError({
      operation: "inspect BTW pane shell",
      code: "herdr_btw_pane_shell_not_ready",
      message:
        "The new Herdr pane did not reach an available shell before the readiness deadline. No Pi launch was attempted.",
      outcome: "confirmed",
    });
  });

/**
 * Fail-closed parent/child file-distinctness: the child path must differ textually AND compare
 * distinct (an unavailable identity never counts as distinct).
 */
export const isDistinctChildSessionPath = (
  childPath: string,
  parentSessionFile: string,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): boolean =>
  childPath !== parentSessionFile &&
  compareSessionFileIdentity(childPath, parentSessionFile) === "distinct";

export const validateStartedAgent = (
  agent: HerdrPane,
  pane: HerdrPane,
  agentName: string,
  parentSessionFile: string,
  expectedChildPath: string,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): Effect.Effect<void, HerdrBtwError> => {
  const childSession = agent.agent_session;
  const hasPathEvidence =
    childSession !== null &&
    childSession !== undefined &&
    childSession.source === "herdr:pi" &&
    childSession.agent === "pi" &&
    childSession.kind === "path";
  const childMatchesLaunch =
    hasPathEvidence && compareSessionFileIdentity(childSession.value, expectedChildPath) === "same";
  const childDiffersFromParent = isDistinctChildSessionPath(
    expectedChildPath,
    parentSessionFile,
    compareSessionFileIdentity,
  );

  if (
    agent.pane_id !== pane.pane_id ||
    agent.terminal_id !== pane.terminal_id ||
    agent.workspace_id !== pane.workspace_id ||
    agent.tab_id !== pane.tab_id ||
    agent.name !== agentName ||
    agent.agent !== "pi" ||
    !hasPathEvidence ||
    !childMatchesLaunch ||
    !childDiffersFromParent
  )
    return Effect.fail(
      new HerdrBtwError({
        operation: "start side-session Pi",
        code: "herdr_agent_ownership_mismatch",
        message: "Herdr returned side-session Pi startup evidence that did not match this launch.",
        outcome: "uncertain",
      }),
    );

  return Effect.void;
};

const linkedAgentSessionIdentity = (
  agent: HerdrPane,
  childSessionId: string,
  childSessionPath: string,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): SessionFileIdentityComparison | undefined => {
  const session = agent.agent_session;
  if (
    session === null ||
    session === undefined ||
    session.source !== "herdr:pi" ||
    session.agent !== "pi"
  )
    return undefined;
  if (session.kind === "id") return session.value === childSessionId ? "same" : "distinct";
  return compareSessionFileIdentity(session.value, childSessionPath);
};

/** Matches stable Herdr metadata to the recorded child filesystem identity. */
const hasLinkedAgentSessionIdentity = (
  agent: HerdrPane,
  childSessionId: string,
  childSessionPath: string,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): boolean =>
  linkedAgentSessionIdentity(
    agent,
    childSessionId,
    childSessionPath,
    compareSessionFileIdentity,
  ) === "same";

/** A recorded name or non-distinct child identity remains conflicting. */
export const isLinkedAgentConflictCandidate = (
  agent: HerdrPane,
  agentName: string,
  childSessionId: string,
  childSessionPath: string,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): boolean => {
  if (agent.name === agentName) return true;
  const identity = linkedAgentSessionIdentity(
    agent,
    childSessionId,
    childSessionPath,
    compareSessionFileIdentity,
  );
  return identity !== undefined && identity !== "distinct";
};

/** Exact recorded Herdr identity required before focusing a linked live Pi. */
export const isExactLinkedAgent = (
  agent: HerdrPane,
  agentName: string,
  terminalId: string,
  childSessionId: string,
  childSessionPath: string,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): boolean =>
  agent.name === agentName &&
  agent.terminal_id === terminalId &&
  agent.agent === "pi" &&
  hasLinkedAgentSessionIdentity(
    agent,
    childSessionId,
    childSessionPath,
    compareSessionFileIdentity,
  );
