import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type {
  LocalCliProcessContract,
  LocalCliProcessHandle,
  LocalCliRuntime,
} from "../boundary/local-cli-process.ts";
import type {
  SupervisorChannelContract,
  SupervisorChannelHandle,
} from "../boundary/supervisor-channel.ts";
import { UnsupportedSubagentCapabilityError, type SubagentError } from "../run/errors.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";
import type {
  BackendControls,
  BackendDriver,
  BackendEvent,
  BackendHandle,
  BackendLaunchRequest,
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
    `Never launch, delegate to, or coordinate another agent. Do not use integrations, plugins, apps, hooks, skills, browser automation, remote control, or MCP servers other than ${SUPERVISOR_MCP_REGISTRATION}.`,
    request.writeIntent === "read-only"
      ? "Read-only Bash is available for inspection and validation inside the runtime's strict filesystem sandbox. Do not attempt to mutate project files or bypass the sandbox; use a writer assignment for intentional project changes."
      : "Writer intent permits project edits within the assigned cwd only; keep changes narrowly within the assignment.",
  ].join("\n\n"),
});

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

export const makeLocalCliBackendDriver =
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
