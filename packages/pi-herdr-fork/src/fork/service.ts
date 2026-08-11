import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AgentEnvelopeSchema,
  LayoutEnvelopeSchema,
  PaneProcessInfoEnvelopeSchema,
  ProtocolSchema,
  command,
  decodeJson,
  makeHerdrCommandRunner,
  paneCommand,
  type HerdrCommandRunner,
  type HerdrPane,
  type HerdrPaneProcessInfo,
} from "../boundary/herdr-client.ts";
import {
  isValidParentSessionFile,
  parentForkDisplayName,
  type HerdrForkSessionInput,
} from "../boundary/host-session.ts";
import { HerdrForkError, herdrForkError } from "./errors.ts";
import { initialForkPrompt, makeAgentName, selectSplitDirection } from "./policy.ts";

const MINIMUM_HERDR_PROTOCOL = 17;
const START_TIMEOUT_MILLIS = 70_000;
const MAX_PROMPT_BYTES = 32 * 1024;
const SHELL_READINESS_ATTEMPTS = 31;
const SHELL_READINESS_DELAY_MILLIS = 200;
const REQUIRED_STABLE_SHELL_READINGS = 6;
const retainPane = (failure: HerdrForkError, paneId: string, guidance: string) =>
  new HerdrForkError({
    ...failure,
    paneId,
    message: `${failure.message} ${guidance}`,
  });
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

export interface HerdrForkResult {
  readonly agentName: string;
  readonly paneId: string;
  readonly childSession: string;
  readonly direction: "right" | "down";
  readonly prompted: boolean;
}

export interface HerdrForkServiceShape {
  readonly open: (prompt?: string | undefined) => Effect.Effect<HerdrForkResult, HerdrForkError>;
}

export interface HerdrForkServiceOptions {
  readonly runner?: HerdrCommandRunner | undefined;
  readonly validateSessionFile?: ((path: string) => boolean) | undefined;
  readonly readinessDelay?: ((milliseconds: number) => Effect.Effect<void>) | undefined;
}

const validateInput = (
  prompt: string | undefined,
  input: HerdrForkSessionInput,
  validateSessionFile: (path: string) => boolean,
): Effect.Effect<{ sessionFile: string; sessionId: string }, HerdrForkError> =>
  Effect.gen(function* () {
    if (input.environment.HERDR_ENV !== "1" || !input.environment.HERDR_PANE_ID)
      return yield* herdrForkError(
        "validate environment",
        "herdr_environment_unavailable",
        "herdr-fork must run from a Pi session inside a Herdr-managed pane with caller identity.",
      );

    if (!input.sessionFile || !validateSessionFile(input.sessionFile))
      return yield* herdrForkError(
        "validate parent session",
        "parent_session_unavailable",
        "The current Pi session does not have a readable persisted session file to fork.",
      );
    if (!input.sessionId)
      return yield* herdrForkError(
        "validate parent session",
        "parent_session_id_unavailable",
        "The current Pi session ID is unavailable.",
      );

    if (
      prompt !== undefined &&
      (prompt.includes("\0") || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES)
    )
      return yield* herdrForkError(
        "validate prompt",
        "fork_prompt_invalid",
        `The optional initial prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes and contain no NUL byte.`,
      );

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
    typeof shellPid === "number" &&
    processInfo.foreground_process_group_id === shellPid &&
    foregroundProcesses.length === 1 &&
    foregroundProcess?.pid === shellPid &&
    HERDR_SHELL_PROCESS_NAMES.has(normalizedProcessName(foregroundProcess.name))
  );
};

const waitForAvailableShell = (
  runner: HerdrCommandRunner,
  paneId: string,
  delay: (milliseconds: number) => Effect.Effect<void>,
): Effect.Effect<void, HerdrForkError> =>
  Effect.gen(function* () {
    let stableReadings = 0;
    for (let attempt = 1; attempt <= SHELL_READINESS_ATTEMPTS; attempt += 1) {
      const output = yield* command(
        runner,
        ["pane", "process-info", "--pane", paneId],
        "inspect fork pane shell",
      );
      const { result } = yield* decodeJson(
        PaneProcessInfoEnvelopeSchema,
        output.stdout,
        "inspect fork pane shell",
      );
      if (result.process_info.pane_id !== paneId)
        return yield* herdrForkError(
          "inspect fork pane shell",
          "herdr_fork_pane_shell_mismatch",
          `Herdr returned process information for a different pane. No Pi launch was attempted. Pane ${paneId} was retained for manual inspection.`,
          "confirmed",
          paneId,
        );
      stableReadings = paneHasAvailableShell(result.process_info) ? stableReadings + 1 : 0;
      if (stableReadings >= REQUIRED_STABLE_SHELL_READINGS) return;
      if (attempt < SHELL_READINESS_ATTEMPTS) yield* delay(SHELL_READINESS_DELAY_MILLIS);
    }

    return yield* herdrForkError(
      "inspect fork pane shell",
      "herdr_fork_pane_shell_not_ready",
      `The new Herdr pane did not reach an available shell before the readiness deadline. No Pi launch was attempted. Pane ${paneId} was retained for manual inspection.`,
      "confirmed",
      paneId,
    );
  });

const validateStartedAgent = (
  agent: HerdrPane,
  pane: HerdrPane,
  agentName: string,
  parentSessionFile: string,
): Effect.Effect<string, HerdrForkError> => {
  const childSession = agent.agent_session;
  if (
    agent.pane_id !== pane.pane_id ||
    agent.terminal_id !== pane.terminal_id ||
    agent.workspace_id !== pane.workspace_id ||
    agent.tab_id !== pane.tab_id ||
    agent.name !== agentName ||
    agent.agent !== "pi" ||
    !childSession ||
    childSession.agent !== "pi" ||
    childSession.kind !== "path" ||
    childSession.value === parentSessionFile
  )
    return Effect.fail(
      herdrForkError(
        "start forked Pi",
        "herdr_agent_ownership_mismatch",
        `Herdr did not return the exact expected forked Pi identity. Pane ${pane.pane_id} was retained for manual inspection.`,
        "uncertain",
        pane.pane_id,
      ),
    );

  return Effect.succeed(childSession.value);
};

export const makeHerdrForkService = (
  input: HerdrForkSessionInput,
  options: HerdrForkServiceOptions = {},
): HerdrForkServiceShape => {
  const runner = options.runner ?? makeHerdrCommandRunner(input.environment);
  const validateSessionFile = options.validateSessionFile ?? isValidParentSessionFile;
  const readinessDelay = options.readinessDelay ?? Effect.sleep;

  const open: HerdrForkServiceShape["open"] = (prompt) =>
    Effect.gen(function* () {
      const { sessionFile, sessionId } = yield* validateInput(prompt, input, validateSessionFile);

      const protocolOutput = yield* command(
        runner,
        ["api", "schema", "--json"],
        "inspect protocol",
      );
      const protocol = yield* decodeJson(ProtocolSchema, protocolOutput.stdout, "inspect protocol");
      if (protocol.protocol < MINIMUM_HERDR_PROTOCOL)
        return yield* herdrForkError(
          "inspect protocol",
          "herdr_upgrade_required",
          `Herdr protocol ${MINIMUM_HERDR_PROTOCOL} or newer is required; found ${protocol.protocol}.`,
        );

      const integrations = yield* command(
        runner,
        ["integration", "status"],
        "inspect Pi integration",
      );
      const piIntegration = integrations.stdout
        .split(/\r?\n/gu)
        .find((line) => line.startsWith("pi:"));
      if (!piIntegration || !/^pi: current \(v\d+\) \(.+\)$/u.test(piIntegration))
        return yield* herdrForkError(
          "inspect Pi integration",
          "herdr_pi_integration_unavailable",
          "The current Herdr Pi integration is required. Run `herdr integration install pi`, then try again.",
        );

      const parentPane = yield* paneCommand(
        runner,
        ["pane", "current", "--current"],
        "resolve calling pane",
      );
      const layoutOutput = yield* command(
        runner,
        ["pane", "layout", "--pane", parentPane.pane_id],
        "inspect calling pane layout",
      );
      const { result: layoutResult } = yield* decodeJson(
        LayoutEnvelopeSchema,
        layoutOutput.stdout,
        "inspect calling pane layout",
      );
      if (
        layoutResult.layout.workspace_id !== parentPane.workspace_id ||
        layoutResult.layout.tab_id !== parentPane.tab_id
      )
        return yield* herdrForkError(
          "inspect calling pane layout",
          "herdr_parent_topology_mismatch",
          "The calling pane changed workspace or tab while its layout was inspected.",
        );

      const direction = selectSplitDirection(layoutResult.layout.area.width);
      const forkPane = yield* paneCommand(
        runner,
        [
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
        "split fork pane",
        true,
      );
      if (
        forkPane.pane_id === parentPane.pane_id ||
        forkPane.workspace_id !== parentPane.workspace_id ||
        forkPane.tab_id !== parentPane.tab_id
      )
        return yield* herdrForkError(
          "split fork pane",
          "herdr_split_topology_mismatch",
          "Herdr returned a pane outside the calling pane's current workspace/tab; no further action was taken.",
          "uncertain",
          forkPane.pane_id,
        );

      yield* waitForAvailableShell(runner, forkPane.pane_id, readinessDelay);

      const retainForkPane = <A>(
        effect: Effect.Effect<A, HerdrForkError>,
      ): Effect.Effect<A, HerdrForkError> =>
        effect.pipe(
          Effect.mapError((failure) =>
            retainPane(
              failure,
              forkPane.pane_id,
              `Pane ${forkPane.pane_id} was retained for manual inspection.`,
            ),
          ),
        );

      const agentName = makeAgentName(sessionId, forkPane.pane_id);
      const displayName = parentForkDisplayName(input.cwd);
      const startedOutput = yield* retainForkPane(
        command(
          runner,
          [
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
          "start forked Pi",
          true,
          START_TIMEOUT_MILLIS,
          ["agent_pane_busy"],
        ),
      );
      const { result: startedResult } = yield* retainForkPane(
        decodeJson(AgentEnvelopeSchema, startedOutput.stdout, "start forked Pi", true),
      );
      const childSession = yield* validateStartedAgent(
        startedResult.agent,
        forkPane,
        agentName,
        sessionFile,
      );

      let promptFailure: HerdrForkError | undefined;
      if (prompt !== undefined) {
        const promptResult = yield* Effect.result(
          command(
            runner,
            ["agent", "prompt", agentName, initialForkPrompt(prompt)],
            "prompt forked Pi",
            true,
          ),
        );
        if (promptResult._tag === "Failure") promptFailure = promptResult.failure;
      }
      const focusResult = yield* Effect.result(
        command(runner, ["agent", "focus", agentName], "focus forked Pi", true),
      );

      if (promptFailure)
        return yield* retainPane(
          promptFailure,
          forkPane.pane_id,
          `The fork is running in pane ${forkPane.pane_id}; enter the prompt there manually.`,
        );
      if (focusResult._tag === "Failure")
        return yield* retainPane(
          focusResult.failure,
          forkPane.pane_id,
          `The fork is running in pane ${forkPane.pane_id}; focus it manually.`,
        );

      return {
        agentName,
        paneId: forkPane.pane_id,
        childSession,
        direction,
        prompted: prompt !== undefined,
      };
    });

  return { open };
};

export class HerdrForkService extends Context.Service<HerdrForkService, HerdrForkServiceShape>()(
  "pi-herdr-fork/fork/service/HerdrForkService",
) {
  static readonly layer = (
    input: HerdrForkSessionInput,
    options: HerdrForkServiceOptions = {},
  ): Layer.Layer<HerdrForkService> => Layer.succeed(this, makeHerdrForkService(input, options));
}
