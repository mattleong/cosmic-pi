import * as Effect from "effect/Effect";
import type {
  SupervisorChannelHandle,
  SupervisorConnectionMetadata,
} from "../../src/boundary/supervisor-channel.ts";
import { SUPERVISOR_MCP_TOOL_NAMES } from "../../src/supervisor/mcp-contract.ts";

export const supervisorMetadata = (
  runId: string,
  options: Partial<
    Pick<
      SupervisorConnectionMetadata,
      "port" | "stateDirectory" | "connectionConfigPath" | "helperPath"
    >
  > & {
    readonly command?: string;
    readonly args?: ReadonlyArray<string>;
    readonly enabledTools?: ReadonlyArray<string>;
    readonly tomlFragment?: string;
  } = {},
): SupervisorConnectionMetadata => ({
  runId,
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
    serverName: "pi_subagents_supervisor",
    command: options.command ?? process.execPath,
    args: options.args ?? ["/private/helper.mjs"],
    enabledTools: options.enabledTools ?? [...SUPERVISOR_MCP_TOOL_NAMES],
    tomlFragment: options.tomlFragment ?? "[mcp_servers.pi_subagents_supervisor]\nrequired = true",
  },
});

// Queues and stateful behavior stay with each test's resource owner.
export const backendSupervisor = (
  metadata: SupervisorConnectionMetadata,
  events: SupervisorChannelHandle["events"],
  behavior: Pick<
    SupervisorChannelHandle,
    "hasAcceptedReport" | "acceptedReportForEpoch" | "close"
  > &
    Partial<Pick<SupervisorChannelHandle, "setAssignmentEpoch">>,
): SupervisorChannelHandle => ({
  runId: metadata.runId,
  metadata,
  events,
  awaitReady: Effect.void,
  setAssignmentEpoch: () => Effect.void,
  deliverNotification: () => Effect.void,
  reply: () => Effect.void,
  cancelPending: () => {},
  ...behavior,
});
