import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { BackendHandle, BackendLaunchRequest } from "../../src/backend/model.ts";
import type {
  SupervisorChannelHandle,
  SupervisorConnectionMetadata,
} from "../../src/boundary/supervisor-channel.ts";

export const supervisorMetadata = (
  options: Partial<
    Pick<
      SupervisorConnectionMetadata,
      "port" | "stateDirectory" | "connectionConfigPath" | "helperPath"
    >
  > & {
    readonly command?: string;
    readonly args?: ReadonlyArray<string>;
    readonly tomlFragment?: string;
  } = {},
): SupervisorConnectionMetadata => ({
  host: "127.0.0.1",
  port: options.port ?? 1,
  stateDirectory: options.stateDirectory ?? "/private/fixture",
  connectionConfigPath: options.connectionConfigPath ?? "/private/fixture/connection.json",
  helperPath: options.helperPath ?? "/private/helper.mjs",
  claudeMcp: {
    mcpServers: {
      pi_subagents_supervisor: {
        type: "stdio",
        command: options.command ?? process.execPath,
        args: options.args ?? ["/private/helper.mjs"],
        env: {},
      },
    },
  },
  codexMcp: {
    tomlFragment: options.tomlFragment ?? "[mcp_servers.pi_subagents_supervisor]\nrequired = true",
  },
});

// Queues and stateful behavior stay with each test's resource owner.
export const backendSupervisor = (
  metadata: SupervisorConnectionMetadata,
  events: SupervisorChannelHandle["events"],
  behavior: Pick<SupervisorChannelHandle, "hasAcceptedReport" | "acceptedReportForEpoch"> &
    Partial<Pick<SupervisorChannelHandle, "setAssignmentEpoch">>,
): SupervisorChannelHandle => ({
  metadata,
  events,
  awaitReady: Effect.void,
  setAssignmentEpoch: () => Effect.void,
  reply: () => Effect.void,
  cancelPending: () => {},
  ...behavior,
});

export const backendLaunch = (
  overrides: Partial<BackendLaunchRequest> = {},
): BackendLaunchRequest => ({
  runId: "agent-fixture",
  name: "fixture",
  cwd: process.cwd(),
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "fixture",
  effort: "high",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "Use the private supervisor report tool.",
  ...overrides,
});

/** Takes the next backend event within a bounded wait, optionally acknowledging its raw owner. */
export const takeBackendEvent = (
  backend: Pick<BackendHandle, "events" | "acknowledge">,
  options: { readonly timeout?: Duration.Input; readonly acknowledge?: boolean } = {},
) =>
  Queue.take(backend.events).pipe(
    Effect.timeoutOption(options.timeout ?? "5 seconds"),
    Effect.flatMap((event) =>
      Option.isSome(event) ? Effect.succeed(event.value) : Effect.die("fixture event timeout"),
    ),
    Effect.tap((event) =>
      Effect.sync(() => {
        if (options.acknowledge) backend.acknowledge(event);
      }),
    ),
    Effect.orDie,
  );
