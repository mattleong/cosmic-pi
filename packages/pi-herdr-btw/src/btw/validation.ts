import * as Effect from "effect/Effect";
import { isInteractiveShellProcessName } from "pi-cosmic-core";
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
import { confirmedFailure, HerdrBtwError } from "./errors.ts";
import type { HerdrBtwLink } from "./link.ts";
import { parseHerdrBtwSessionId } from "./marker.ts";

const MINIMUM_HERDR_PROTOCOL = 17;
const MAX_PROMPT_BYTES = 32 * 1024;
const SHELL_READINESS_ATTEMPTS = 31;
const SHELL_READINESS_DELAY_MILLIS = 200;
const REQUIRED_STABLE_SHELL_READINGS = 6;

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
      return yield* confirmedFailure(
        "inspect protocol",
        "herdr_upgrade_required",
        `Herdr protocol ${MINIMUM_HERDR_PROTOCOL} or newer is required; found ${protocol}.`,
      );
  });

export const ensurePiIntegration = (
  client: HerdrClientContract,
): Effect.Effect<void, HerdrBtwError> =>
  Effect.gen(function* () {
    if (!(yield* client.inspectPiIntegration()))
      return yield* confirmedFailure(
        "inspect Pi integration",
        "herdr_pi_integration_unavailable",
        "The current Herdr Pi integration is required. Run `herdr integration install pi`, then try again.",
      );
  });

const parentSessionUnavailable = () =>
  confirmedFailure(
    "validate parent session",
    "parent_session_unavailable",
    "The current Pi session does not have a readable persisted session file to reference.",
  );

export const validateBtwInput = (
  prompt: string | undefined,
  input: HerdrBtwSessionInput,
  probeSessionHeader: (path: string) => SessionHeaderProbe,
): Effect.Effect<{ sessionFile: string; sessionId: string }, HerdrBtwError> =>
  Effect.gen(function* () {
    if (input.environment.HERDR_ENV !== "1" || !input.environment.HERDR_PANE_ID)
      return yield* confirmedFailure(
        "validate environment",
        "herdr_environment_unavailable",
        "herdr-btw must run from a Pi session inside a Herdr-managed pane with caller identity.",
      );

    if (!input.sessionFile) return yield* parentSessionUnavailable();
    const sessionId = parseHerdrBtwSessionId(input.sessionId);
    if (sessionId === undefined)
      return yield* confirmedFailure(
        "validate parent session",
        "parent_session_id_unavailable",
        "The current Pi session ID is unavailable or invalid.",
      );
    const parentProbe = probeSessionHeader(input.sessionFile);
    if (parentProbe._tag !== "valid") return yield* parentSessionUnavailable();
    if (parentProbe.header.id !== sessionId)
      return yield* confirmedFailure(
        "validate parent session",
        "parent_session_owner_mismatch",
        "The parent session file header does not match the current Pi session identity.",
      );

    if (
      prompt !== undefined &&
      (prompt.includes("\0") || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
    )
      return yield* confirmedFailure(
        "validate prompt",
        "btw_prompt_invalid",
        `The optional initial prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes and contain no NUL byte.`,
      );

    return { sessionFile: input.sessionFile, sessionId };
  });

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
    isInteractiveShellProcessName(foregroundProcess.name)
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
        return yield* confirmedFailure(
          "inspect BTW pane shell",
          "herdr_btw_pane_shell_mismatch",
          "Herdr returned process information for a different pane. No Pi launch was attempted.",
        );
      stableReadings = paneHasAvailableShell(processInfo) ? stableReadings + 1 : 0;
      if (stableReadings >= REQUIRED_STABLE_SHELL_READINGS) return;
      if (attempt < SHELL_READINESS_ATTEMPTS) yield* Effect.sleep(SHELL_READINESS_DELAY_MILLIS);
    }

    return yield* confirmedFailure(
      "inspect BTW pane shell",
      "herdr_btw_pane_shell_not_ready",
      "The new Herdr pane did not reach an available shell before the readiness deadline. No Pi launch was attempted.",
    );
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

const piAgentSession = (agent: HerdrPane) => {
  const session = agent.agent_session;
  return session?.source === "herdr:pi" && session.agent === "pi" ? session : undefined;
};

export const validateStartedAgent = (
  agent: HerdrPane,
  pane: HerdrPane,
  agentName: string,
  parentSessionFile: string,
  expectedChildPath: string,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): Effect.Effect<void, HerdrBtwError> => {
  const childSession = piAgentSession(agent);
  if (
    agent.pane_id !== pane.pane_id ||
    agent.terminal_id !== pane.terminal_id ||
    agent.workspace_id !== pane.workspace_id ||
    agent.tab_id !== pane.tab_id ||
    agent.name !== agentName ||
    agent.agent !== "pi" ||
    childSession?.kind !== "path" ||
    compareSessionFileIdentity(childSession.value, expectedChildPath) !== "same" ||
    !isDistinctChildSessionPath(expectedChildPath, parentSessionFile, compareSessionFileIdentity)
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
  link: HerdrBtwLink,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): SessionFileIdentityComparison | undefined => {
  const session = piAgentSession(agent);
  if (session === undefined) return undefined;
  if (session.kind === "id") return session.value === link.childSessionId ? "same" : "distinct";
  return compareSessionFileIdentity(session.value, link.childSessionPath);
};

/** A recorded name or non-distinct child identity remains conflicting. */
export const isLinkedAgentConflictCandidate = (
  agent: HerdrPane,
  link: HerdrBtwLink,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): boolean => {
  if (agent.name === link.agentName) return true;
  const identity = linkedAgentSessionIdentity(agent, link, compareSessionFileIdentity);
  return identity !== undefined && identity !== "distinct";
};

/** Exact recorded Herdr identity required before focusing a linked live Pi. */
export const isExactLinkedAgent = (
  agent: HerdrPane,
  link: HerdrBtwLink,
  compareSessionFileIdentity: SessionFileIdentityComparator,
): boolean =>
  agent.name === link.agentName &&
  agent.terminal_id === link.terminalId &&
  agent.agent === "pi" &&
  linkedAgentSessionIdentity(agent, link, compareSessionFileIdentity) === "same";
