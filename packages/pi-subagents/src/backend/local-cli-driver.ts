import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type {
  LocalCliProcessContract,
  LocalCliProcessHandle,
  LocalCliRuntime,
} from "../boundary/local-cli-process.ts";
import type { LocalCliHandle, LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type { ProcessExit } from "../boundary/process-transport.ts";
import type {
  SupervisorChannelContract,
  SupervisorChannelHandle,
} from "../boundary/supervisor-channel.ts";
import {
  processError,
  UnsupportedSubagentCapabilityError,
  type SubagentError,
  type SubagentProcessError,
} from "../run/errors.ts";
import { MAX_ERROR_CHARS, sanitizeStreamDiagnostic } from "../run/state.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import {
  toBackendExit,
  type BackendControls,
  type BackendDriver,
  type BackendEvent,
  type BackendHandle,
  type BackendLaunchRequest,
} from "./model.ts";
import { supervisorError } from "./driver-shared.ts";

const REPORT_TOOL = SUPERVISOR_MCP_TOOL_NAMES[3];

export const withLocalSupervisorInstructions = (
  request: BackendLaunchRequest,
): BackendLaunchRequest => ({
  ...request,
  systemPrompt: [
    request.systemPrompt,
    `For this local CLI harness, use only the ${SUPERVISOR_MCP_REGISTRATION} MCP tools for parent communication: ${SUPERVISOR_MCP_TOOL_NAMES.join(", ")}. The contact_parent name in generic instructions refers to these tools.`,
    `A ${REPORT_TOOL} call is the only completion signal. Submit one concise final report with a fresh bounded delivery_id after the assignment is complete. Raw final assistant text does not complete the run.`,
    "You may use this runtime's native agents for clearly independent slices; most tasks need none. Only you contact the parent or submit the report, so have native agents return their results to you and include what matters in your report.",
    `Do not use integrations, plugins, apps, hooks, skills, browser automation, remote control, or MCP servers other than ${SUPERVISOR_MCP_REGISTRATION}.`,
    request.writeIntent === "read-only"
      ? "Read-only Bash is available for inspection and validation inside the runtime's strict filesystem sandbox. Do not attempt to mutate project files or bypass the sandbox; use a writer assignment for intentional project changes."
      : "Writer intent permits project edits within the assigned cwd only; keep changes narrowly within the assignment.",
  ].join("\n\n"),
});

const RUNTIME_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
} as const satisfies Record<LocalCliRuntime, string>;

/** The exit status on the first line, then the end of the CLI's bounded, redacted stderr. */
export const localCliExitDiagnostic = (runtime: LocalCliRuntime, exit: ProcessExit): string => {
  const summary = `${RUNTIME_LABELS[runtime]} exited${exit.exitCode === null ? "" : ` with code ${exit.exitCode}`}${exit.signal ? ` (${exit.signal})` : ""}.`;
  const stderr = exit.stderr.trim();
  return stderr
    ? `${summary}\n${sanitizeStreamDiagnostic(stderr, MAX_ERROR_CHARS - summary.length - 1)}`
    : summary;
};

export const localCliBackendExit = (runtime: LocalCliRuntime, exit: ProcessExit) => ({
  ...toBackendExit(exit),
  diagnostic: localCliExitDiagnostic(runtime, exit),
});

/**
 * Consumes native frames until the process closes, then hands pending work the exit diagnostic.
 * The transport ends its frames only after the process closes, so the exit receipt is already
 * settled; scope interruption skips the wait and reports a generic closure instead.
 */
export const consumeUntilExit = (
  runtime: LocalCliRuntime,
  child: Pick<LocalCliHandle, "events" | "awaitExit">,
  consume: (raw: LocalCliWireEvent) => Effect.Effect<void>,
  onClosed: (failure: SubagentProcessError) => Effect.Effect<void>,
): Effect.Effect<void> => {
  let failure: SubagentProcessError | undefined;
  return Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consume),
    Effect.andThen(child.awaitExit),
    Effect.tap((exit) =>
      Effect.sync(() => {
        failure = processError(
          "run",
          `local_${runtime}_exited`,
          localCliExitDiagnostic(runtime, exit),
        );
      }),
    ),
    Effect.ignoreCause,
    Effect.ensuring(
      Effect.suspend(() =>
        onClosed(
          failure ??
            processError(
              "run",
              `local_${runtime}_transport_closed`,
              `Local ${RUNTIME_LABELS[runtime]} transport closed.`,
            ),
        ),
      ),
    ),
  );
};

export const deliverTerminalReport = (
  events: Queue.Queue<BackendEvent, Cause.Done>,
  delivery: Effect.Effect<void>,
  scope: Scope.Scope,
): Effect.Effect<void> =>
  delivery.pipe(
    Effect.interruptible,
    Effect.ensuring(Effect.sync(() => Queue.endUnsafe(events))),
    Effect.forkIn(scope),
    Effect.asVoid,
  );

type LocalCliBackendHandle = Omit<BackendHandle, "controls"> & {
  readonly controls: Pick<BackendControls, "initialize" | "start" | "steer" | "interrupt">;
};

export const localCliBackendDriver =
  (
    runtime: LocalCliRuntime,
    unsupportedMessage: (capability: string) => string,
    makeHandle: (
      launch: BackendLaunchRequest,
      child: LocalCliProcessHandle,
      supervisor: SupervisorChannelHandle,
    ) => Effect.Effect<LocalCliBackendHandle, SubagentError, Scope.Scope>,
  ) =>
  (processes: LocalCliProcessContract, supervisors: SupervisorChannelContract): BackendDriver => {
    const unsupported = (capability: string) =>
      Effect.fail(
        new UnsupportedSubagentCapabilityError({
          backend: `local/${runtime}`,
          capability,
          message: unsupportedMessage(capability),
        }),
      );
    return {
      host: "local",
      runtime,
      capabilities: ["steer", "interrupt", "parent-contact"],
      supportsContext: (context) => context === "fresh",
      preflight: (request) => processes.preflight({ runtime, ...request }),
      spawn: (request) =>
        Effect.gen(function* () {
          const launch = withLocalSupervisorInstructions(request);
          const supervisor = yield* Effect.mapError(
            supervisors.open({
              runId: request.runId,
            }),
            supervisorError("open supervisor channel"),
          );
          const child = yield* processes.spawn({
            runtime,
            launch,
            supervisor: supervisor.metadata,
          });
          const handle = yield* makeHandle(launch, child, supervisor);
          return {
            ...handle,
            controls: {
              ...handle.controls,
              renameDisplay: () => unsupported("rename-display"),
              reply: (requestId: string, message: string) =>
                supervisor
                  .reply(requestId, message)
                  .pipe(Effect.mapError(supervisorError("reply"))),
              notifyPeers: () => unsupported("peer-notice"),
            },
          };
        }),
    };
  };
