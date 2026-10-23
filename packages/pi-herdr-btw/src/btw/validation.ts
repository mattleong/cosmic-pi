import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { isInteractiveShellProcessName } from "pi-cosmic-core";
import type {
  HerdrClientContract,
  HerdrPane,
  HerdrPaneProcessInfo,
} from "../boundary/herdr-client.ts";
import type { HerdrBtwSessionInput } from "../boundary/host-session.ts";
import {
  SessionHeaderProbe,
  type HerdrSessionFilesContract,
  type SessionFileIdentityComparison,
} from "../boundary/session-file.ts";
import { confirmedFailure } from "./errors.ts";
import type { HerdrBtwLink } from "./link.ts";
import { parseHerdrBtwSessionId } from "./marker.ts";

const MINIMUM_HERDR_PROTOCOL = 17;
const MAX_PROMPT_BYTES = 32 * 1024;
const SHELL_READINESS_ATTEMPTS = 31;
const SHELL_READINESS_DELAY_MILLIS = 200;
const REQUIRED_STABLE_SHELL_READINGS = 6;

export const isValidBlankChildProbe = (
  probe: SessionHeaderProbe,
  childSessionId: string,
): boolean =>
  SessionHeaderProbe.$is("valid")(probe) &&
  probe.header.id === childSessionId &&
  probe.header.parentSession === undefined;

export const ensureHerdrProtocol = Effect.fn("HerdrBtw.ensureHerdrProtocol")(function* (
  client: HerdrClientContract,
) {
  const protocol = yield* client.inspectProtocol();
  if (protocol < MINIMUM_HERDR_PROTOCOL)
    return yield* confirmedFailure(
      "inspect protocol",
      "herdr_upgrade_required",
      `Herdr BTW needs Herdr protocol ${MINIMUM_HERDR_PROTOCOL} or newer (found ${protocol})`,
    );
  return undefined;
});

export const ensurePiIntegration = Effect.fn("HerdrBtw.ensurePiIntegration")(function* (
  client: HerdrClientContract,
) {
  if (!(yield* client.inspectPiIntegration()))
    return yield* confirmedFailure(
      "inspect Pi integration",
      "herdr_pi_integration_unavailable",
      "Herdr BTW needs Herdr's Pi integration; run herdr integration install pi, then try again",
    );
  return undefined;
});

const parentSessionUnavailable = () =>
  confirmedFailure(
    "validate parent session",
    "parent_session_unavailable",
    "This Pi session has no saved session file to link to",
  );

export const validateBtwInput = Effect.fn("HerdrBtw.validateBtwInput")(function* (
  prompt: string | undefined,
  input: HerdrBtwSessionInput,
  files: HerdrSessionFilesContract,
) {
  if (input.environment.HERDR_ENV !== "1" || !input.environment.HERDR_PANE_ID)
    return yield* confirmedFailure(
      "validate environment",
      "herdr_environment_unavailable",
      "Herdr BTW only works in a Pi session inside a Herdr pane",
    );

  if (!input.sessionFile) return yield* parentSessionUnavailable();
  const sessionId = parseHerdrBtwSessionId(input.sessionId);
  if (sessionId === undefined)
    return yield* confirmedFailure(
      "validate parent session",
      "parent_session_id_unavailable",
      "Couldn't read this Pi session's ID",
    );
  const parentProbe = yield* files.probeSessionHeader(input.sessionFile);
  if (!SessionHeaderProbe.$is("valid")(parentProbe)) return yield* parentSessionUnavailable();
  if (parentProbe.header.id !== sessionId)
    return yield* confirmedFailure(
      "validate parent session",
      "parent_session_owner_mismatch",
      "This session's file belongs to a different Pi session",
    );

  if (
    prompt !== undefined &&
    (Fn.pipe(prompt, Str.includes("\0")) || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
  )
    return yield* confirmedFailure(
      "validate prompt",
      "btw_prompt_invalid",
      `The prompt must be at most ${MAX_PROMPT_BYTES} bytes with no NUL characters`,
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

export const waitForAvailableShell = Effect.fn("HerdrBtw.waitForAvailableShell")(function* (
  client: HerdrClientContract,
  paneId: string,
) {
  let stableReadings = 0;
  for (let attempt = 1; attempt <= SHELL_READINESS_ATTEMPTS; attempt += 1) {
    const processInfo = yield* client.inspectPaneProcessInfo(paneId);
    if (processInfo.pane_id !== paneId)
      return yield* confirmedFailure(
        "inspect BTW pane shell",
        "herdr_btw_pane_shell_mismatch",
        "Herdr reported a different pane, so Pi wasn't started",
      );
    stableReadings = paneHasAvailableShell(processInfo) ? stableReadings + 1 : 0;
    if (stableReadings >= REQUIRED_STABLE_SHELL_READINGS) return undefined;
    if (attempt < SHELL_READINESS_ATTEMPTS) yield* Effect.sleep(SHELL_READINESS_DELAY_MILLIS);
  }

  return yield* confirmedFailure(
    "inspect BTW pane shell",
    "herdr_btw_pane_shell_not_ready",
    "The new pane's shell didn't become ready in time, so Pi wasn't started",
  );
});

export const isDistinctChildSessionPath = (
  files: HerdrSessionFilesContract,
  childPath: string,
  parentSessionFile: string,
): Effect.Effect<boolean> =>
  childPath === parentSessionFile
    ? Effect.succeed(false)
    : files
        .compareSessionFileIdentity(childPath, parentSessionFile)
        .pipe(Effect.map((identity) => identity === "distinct"));

const piAgentSession = (agent: HerdrPane) => {
  const session = agent.agent_session;
  return session?.source === "herdr:pi" && session.agent === "pi" ? session : undefined;
};

export const isOwnedStartedAgent = Effect.fn("HerdrBtw.isOwnedStartedAgent")(function* (
  files: HerdrSessionFilesContract,
  agent: HerdrPane,
  pane: HerdrPane,
  agentName: string,
  parentSessionFile: string,
  expectedChildPath: string,
) {
  const childSession = piAgentSession(agent);
  return (
    agent.pane_id === pane.pane_id &&
    agent.terminal_id === pane.terminal_id &&
    agent.workspace_id === pane.workspace_id &&
    agent.tab_id === pane.tab_id &&
    agent.name === agentName &&
    agent.agent === "pi" &&
    childSession?.kind === "path" &&
    (yield* files.compareSessionFileIdentity(childSession.value, expectedChildPath)) === "same" &&
    (yield* isDistinctChildSessionPath(files, expectedChildPath, parentSessionFile))
  );
});

const linkedAgentSessionIdentity = (
  files: HerdrSessionFilesContract,
  agent: HerdrPane,
  link: HerdrBtwLink,
): Effect.Effect<SessionFileIdentityComparison | undefined> => {
  const session = piAgentSession(agent);
  if (session === undefined) return Effect.undefined;
  if (session.kind === "id")
    return Effect.succeed(session.value === link.childSessionId ? "same" : "distinct");
  return files.compareSessionFileIdentity(session.value, link.childSessionPath);
};

export const isLinkedAgentConflictCandidate = (
  files: HerdrSessionFilesContract,
  agent: HerdrPane,
  link: HerdrBtwLink,
): Effect.Effect<boolean> =>
  agent.name === link.agentName
    ? Effect.succeed(true)
    : linkedAgentSessionIdentity(files, agent, link).pipe(
        Effect.map((identity) => identity !== undefined && identity !== "distinct"),
      );

export const isExactLinkedAgent = (
  files: HerdrSessionFilesContract,
  agent: HerdrPane,
  link: HerdrBtwLink,
): Effect.Effect<boolean> =>
  agent.name === link.agentName && agent.terminal_id === link.terminalId && agent.agent === "pi"
    ? linkedAgentSessionIdentity(files, agent, link).pipe(
        Effect.map((identity) => identity === "same"),
      )
    : Effect.succeed(false);
