import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import {
  AgentEnvelopeSchema,
  LayoutEnvelopeSchema,
  PaneEnvelopeSchema,
  PaneProcessInfoEnvelopeSchema,
  ProtocolSchema,
  herdrCommand,
  makeHerdrCommandRunner,
  type HerdrCommandRunner,
  type HerdrPane,
  type HerdrPaneProcessInfo,
} from "../boundary/herdr-client.ts";
import {
  isValidParentSessionFile,
  parentForkDisplayName,
  type HerdrForkSessionInput,
} from "../boundary/host-session.ts";
import { HerdrForkError } from "./errors.ts";
import { initialForkPrompt, makeAgentName, selectSplitDirection } from "./policy.ts";

const MINIMUM_HERDR_PROTOCOL = 17;
const START_TIMEOUT_MILLIS = 70_000;
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

const retainPaneFailure = (
  failure: HerdrForkError,
  paneId: string,
  guidance: string = `Pane ${paneId} was retained for manual inspection.`,
): HerdrForkError =>
  failure.paneId === paneId
    ? failure
    : new HerdrForkError({ ...failure, paneId, message: `${failure.message} ${guidance}` });

export interface HerdrForkResult {
  readonly agentName: string;
  readonly paneId: string;
  readonly direction: "right" | "down";
  readonly prompted: boolean;
}

interface HerdrForkServiceOptions {
  readonly runner?: HerdrCommandRunner | undefined;
  readonly validateSessionFile?: ((path: string) => boolean) | undefined;
}

const validateInput = (
  prompt: string | undefined,
  input: HerdrForkSessionInput,
  validateSessionFile: (path: string) => boolean,
): Effect.Effect<{ sessionFile: string; sessionId: string }, HerdrForkError> =>
  Effect.gen(function* () {
    if (input.environment.HERDR_ENV !== "1" || !input.environment.HERDR_PANE_ID)
      return yield* new HerdrForkError({
        operation: "validate environment",
        code: "herdr_environment_unavailable",
        message:
          "herdr-fork must run from a Pi session inside a Herdr-managed pane with caller identity.",
        outcome: "confirmed",
      });

    if (!input.sessionFile || !validateSessionFile(input.sessionFile))
      return yield* new HerdrForkError({
        operation: "validate parent session",
        code: "parent_session_unavailable",
        message: "The current Pi session does not have a readable persisted session file to fork.",
        outcome: "confirmed",
      });
    if (!input.sessionId)
      return yield* new HerdrForkError({
        operation: "validate parent session",
        code: "parent_session_id_unavailable",
        message: "The current Pi session ID is unavailable.",
        outcome: "confirmed",
      });

    if (
      prompt !== undefined &&
      (prompt.includes("\0") || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
    )
      return yield* new HerdrForkError({
        operation: "validate prompt",
        code: "fork_prompt_invalid",
        message: `The optional initial prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes and contain no NUL byte.`,
        outcome: "confirmed",
      });

    return { sessionFile: input.sessionFile, sessionId: input.sessionId };
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

const waitForAvailableShell = (
  runner: HerdrCommandRunner,
  paneId: string,
): Effect.Effect<void, HerdrForkError> =>
  Effect.gen(function* () {
    let stableReadings = 0;
    for (let attempt = 1; attempt <= SHELL_READINESS_ATTEMPTS; attempt += 1) {
      const { result } = yield* herdrCommand(runner, {
        args: ["pane", "process-info", "--pane", paneId],
        operation: "inspect fork pane shell",
        schema: PaneProcessInfoEnvelopeSchema,
      });
      if (result.process_info.pane_id !== paneId)
        return yield* new HerdrForkError({
          operation: "inspect fork pane shell",
          code: "herdr_fork_pane_shell_mismatch",
          message:
            "Herdr returned process information for a different pane. No Pi launch was attempted.",
          outcome: "confirmed",
        });
      stableReadings = paneHasAvailableShell(result.process_info) ? stableReadings + 1 : 0;
      if (stableReadings >= REQUIRED_STABLE_SHELL_READINGS) return;
      if (attempt < SHELL_READINESS_ATTEMPTS) yield* Effect.sleep(SHELL_READINESS_DELAY_MILLIS);
    }

    return yield* new HerdrForkError({
      operation: "inspect fork pane shell",
      code: "herdr_fork_pane_shell_not_ready",
      message:
        "The new Herdr pane did not reach an available shell before the readiness deadline. No Pi launch was attempted.",
      outcome: "confirmed",
    });
  });

const validateStartedAgent = (
  agent: HerdrPane,
  pane: HerdrPane,
  agentName: string,
  parentSessionFile: string,
): Effect.Effect<void, HerdrForkError> => {
  const childSession = agent.agent_session;
  if (
    agent.pane_id !== pane.pane_id ||
    agent.terminal_id !== pane.terminal_id ||
    agent.workspace_id !== pane.workspace_id ||
    agent.tab_id !== pane.tab_id ||
    agent.name !== agentName ||
    agent.agent !== "pi" ||
    (childSession !== null &&
      childSession !== undefined &&
      (childSession.source !== "herdr:pi" ||
        childSession.agent !== "pi" ||
        childSession.kind !== "path" ||
        childSession.value === parentSessionFile))
  )
    return Effect.fail(
      new HerdrForkError({
        operation: "start forked Pi",
        code: "herdr_agent_ownership_mismatch",
        message: "Herdr returned forked Pi startup evidence that did not match this launch.",
        outcome: "uncertain",
      }),
    );

  return Effect.void;
};

export const makeHerdrForkService = (
  input: HerdrForkSessionInput,
  options: HerdrForkServiceOptions = {},
) => {
  const runner = options.runner ?? makeHerdrCommandRunner(input.environment);
  const validateSessionFile = options.validateSessionFile ?? isValidParentSessionFile;

  const open: (prompt?: string | undefined) => Effect.Effect<HerdrForkResult, HerdrForkError> =
    Effect.fn("HerdrForkService.open")(function* (prompt?: string | undefined) {
      const { sessionFile, sessionId } = yield* validateInput(prompt, input, validateSessionFile);

      const protocol = yield* herdrCommand(runner, {
        args: ["api", "schema", "--json"],
        operation: "inspect protocol",
        schema: ProtocolSchema,
      });
      if (protocol.protocol < MINIMUM_HERDR_PROTOCOL)
        return yield* new HerdrForkError({
          operation: "inspect protocol",
          code: "herdr_upgrade_required",
          message: `Herdr protocol ${MINIMUM_HERDR_PROTOCOL} or newer is required; found ${protocol.protocol}.`,
          outcome: "confirmed",
        });

      const integrations = yield* runner({
        args: ["integration", "status"],
        operation: "inspect Pi integration",
      });
      const piIntegration = integrations.stdout
        .split(/\r?\n/gu)
        .find((line) => line.startsWith("pi:"));
      if (!piIntegration || !/^pi: current \(v\d+\) \(.+\)$/u.test(piIntegration))
        return yield* new HerdrForkError({
          operation: "inspect Pi integration",
          code: "herdr_pi_integration_unavailable",
          message:
            "The current Herdr Pi integration is required. Run `herdr integration install pi`, then try again.",
          outcome: "confirmed",
        });

      const parentPane = (yield* herdrCommand(runner, {
        args: ["pane", "current", "--current"],
        operation: "resolve calling pane",
        schema: PaneEnvelopeSchema,
      })).result.pane;
      const { result: layoutResult } = yield* herdrCommand(runner, {
        args: ["pane", "layout", "--pane", parentPane.pane_id],
        operation: "inspect calling pane layout",
        schema: LayoutEnvelopeSchema,
      });
      if (
        layoutResult.layout.workspace_id !== parentPane.workspace_id ||
        layoutResult.layout.tab_id !== parentPane.tab_id
      )
        return yield* new HerdrForkError({
          operation: "inspect calling pane layout",
          code: "herdr_parent_topology_mismatch",
          message: "The calling pane changed workspace or tab while its layout was inspected.",
          outcome: "confirmed",
        });

      const direction = selectSplitDirection(layoutResult.layout.area.width);
      const forkPane = (yield* herdrCommand(runner, {
        args: [
          "pane",
          "split",
          parentPane.pane_id,
          "--direction",
          direction,
          "--ratio",
          "0.5",
          "--cwd",
          input.cwd,
          "--no-focus",
        ],
        operation: "split fork pane",
        mutation: true,
        schema: PaneEnvelopeSchema,
      })).result.pane;
      return yield* Effect.gen(function* () {
        if (
          forkPane.pane_id === parentPane.pane_id ||
          forkPane.workspace_id !== parentPane.workspace_id ||
          forkPane.tab_id !== parentPane.tab_id
        )
          return yield* new HerdrForkError({
            operation: "split fork pane",
            code: "herdr_split_topology_mismatch",
            message:
              "Herdr returned a pane outside the calling pane's current workspace/tab; no further action was taken.",
            outcome: "uncertain",
          });

        yield* waitForAvailableShell(runner, forkPane.pane_id);

        const agentName = makeAgentName(sessionId, forkPane.pane_id);
        const displayName = parentForkDisplayName(input.cwd);
        const { result: startedResult } = yield* herdrCommand(runner, {
          args: [
            "agent",
            "start",
            agentName,
            "--kind",
            "pi",
            "--pane",
            forkPane.pane_id,
            "--timeout",
            "60000",
            "--",
            "--fork",
            sessionFile,
            "--name",
            displayName,
          ],
          operation: "start forked Pi",
          mutation: true,
          timeoutMillis: START_TIMEOUT_MILLIS,
          confirmedRejectionCodes: ["agent_pane_busy"],
          schema: AgentEnvelopeSchema,
        });
        yield* validateStartedAgent(startedResult.agent, forkPane, agentName, sessionFile);

        const promptResult =
          prompt === undefined
            ? undefined
            : yield* Effect.result(
                runner({
                  args: ["agent", "prompt", agentName, initialForkPrompt(prompt)],
                  operation: "prompt forked Pi",
                  mutation: true,
                }),
              );
        const focusResult = yield* Effect.result(
          runner({
            args: ["agent", "focus", agentName],
            operation: "focus forked Pi",
            mutation: true,
          }),
        );

        if (promptResult?._tag === "Failure")
          return yield* retainPaneFailure(
            promptResult.failure,
            forkPane.pane_id,
            `The fork is running in pane ${forkPane.pane_id}; enter the prompt there manually.`,
          );
        if (focusResult._tag === "Failure")
          return yield* retainPaneFailure(
            focusResult.failure,
            forkPane.pane_id,
            `The fork is running in pane ${forkPane.pane_id}; focus it manually.`,
          );

        return {
          agentName,
          paneId: forkPane.pane_id,
          direction,
          prompted: prompt !== undefined,
        };
      }).pipe(Effect.mapError((failure) => retainPaneFailure(failure, forkPane.pane_id)));
    });

  return { open } as const;
};

export class HerdrForkService extends Context.Service<
  HerdrForkService,
  ReturnType<typeof makeHerdrForkService>
>()("pi-herdr-fork/fork/service/HerdrForkService") {}
