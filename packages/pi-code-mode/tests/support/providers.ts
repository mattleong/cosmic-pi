import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  BACKGROUND_TASK_PRESENTATION_VERSION,
  normalizeBackgroundTaskCodeModeQuery,
  type BackgroundTaskCodeModeCapability,
} from "pi-background-task/code-mode";
import {
  MCP_CODE_MODE_QUERY,
  MCP_CODE_MODE_VERSION,
  normalizeMcpCodeModeQuery,
  type McpCodeModeCapability,
} from "pi-mcp/code-mode";

/** The session the execution harness and these providers share unless a test names another. */
export const TEST_SESSION_ID = "test-session";

type Events = ExtensionAPI["events"];

// Provider replies stay loosely typed: tests deliberately return output the consumer must reject.
type McpExecute = (...args: Parameters<McpCodeModeCapability["execute"]>) => Promise<object>;
type BackgroundTaskExecute = (
  ...args: Parameters<BackgroundTaskCodeModeCapability["execute"]>
) => Promise<object>;

interface ProviderOptions {
  /** An existing bus to answer on; a fresh one by default. */
  readonly events?: Events;
  readonly sessionId?: string;
}

/** One valid MCP provider answering discovery through the real query normalizer. */
export const mcpProvider = (execute: McpExecute, options: ProviderOptions = {}): Events => {
  const events = options.events ?? createEventBus();
  events.on(MCP_CODE_MODE_QUERY, (value) =>
    normalizeMcpCodeModeQuery(value)?.respond({
      version: MCP_CODE_MODE_VERSION,
      sessionId: options.sessionId ?? TEST_SESSION_ID,
      execute,
    }),
  );
  return events;
};

/**
 * One valid Background Tasks provider answering discovery through the real query normalizer.
 * `presentationVersion` stays absent unless given, as for an older companion.
 */
export const backgroundTaskProvider = (
  execute: BackgroundTaskExecute,
  options: ProviderOptions & {
    readonly presentationVersion?: typeof BACKGROUND_TASK_PRESENTATION_VERSION;
  } = {},
): Events => {
  const events = options.events ?? createEventBus();
  events.on(BACKGROUND_TASK_CODE_MODE_QUERY, (value) =>
    normalizeBackgroundTaskCodeModeQuery(value)?.respond({
      version: BACKGROUND_TASK_CODE_MODE_VERSION,
      sessionId: options.sessionId ?? TEST_SESSION_ID,
      ...(options.presentationVersion !== undefined && {
        presentationVersion: options.presentationVersion,
      }),
      execute,
    }),
  );
  return events;
};
