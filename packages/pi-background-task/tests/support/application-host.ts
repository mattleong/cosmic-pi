import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { JsonDocumentStore, nodeFilePlatformLayer, type JsonObject } from "pi-cosmic-core";
import {
  agentBeforeSettleEventFixture,
  extensionContextFixture,
  recordingExtensionHost,
  type DefaultedEventName,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  registerBackgroundTaskApplication,
  type BackgroundTaskApplicationBoundaries,
} from "../../src/application.ts";
import { BackgroundTaskDetailsSchema } from "../../src/task/schema.ts";
import type { BackgroundTaskToolInput } from "../../src/tools/schema.ts";

/** An untrusted rpc session's context; it has a UI only when `ui` is given. */
export const sessionContext = (
  options: {
    readonly cwd?: string;
    readonly signal?: AbortSignal | undefined;
    readonly ui?: Partial<ExtensionUIContext>;
    readonly sessionId?: string;
  } = {},
) => {
  const { ui, sessionId } = options;
  return extensionContextFixture({
    cwd: options.cwd ?? process.cwd(),
    signal: options.signal,
    isProjectTrusted: () => false,
    hasUI: ui !== undefined,
    mode: "rpc",
    ...(ui && { ui }),
    ...(sessionId !== undefined && {
      sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    }),
  });
};

export const decodeDetails = Schema.decodeUnknownSync(BackgroundTaskDetailsSchema);

const useAgentDirectory = (directory: string) =>
  Effect.sync(() => vi.stubEnv("PI_CODING_AGENT_DIR", directory));

/**
 * Registers the application against a scoped temporary agent directory, so the real runtime
 * never reads the developer's settings or writes to their package log. The test file unstubs the
 * environment after each test.
 */
export const applicationHost = (
  loadSettings: BackgroundTaskApplicationBoundaries["loadSettings"],
  options: {
    readonly events?: ExtensionAPI["events"];
    readonly settings?: JsonObject;
    readonly host?: Partial<ExtensionAPI>;
    /** Registers as a subagent's own Pi session, whatever session runs the tests. */
    readonly subagentChild?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const documents = yield* JsonDocumentStore;
    const agentDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "pi-background-application-",
    });
    const settingsPath = path.join(agentDirectory, "extensions", "pi-background-task.json");
    if (options.settings) yield* documents.writeObject(settingsPath, options.settings);
    yield* useAgentDirectory(agentDirectory);
    vi.stubEnv("PI_SUBAGENT_CHILD", options.subagentChild ? "1" : undefined);
    // A regular file where the agent directory belongs makes session startup fail.
    const blocker = path.join(agentDirectory, "not-a-directory");
    const host = recordingExtensionHost(
      {},
      { ...options.host, events: options.events ?? createEventBus() },
    );
    registerBackgroundTaskApplication(host.pi, { loadSettings });
    const execute = (
      input: BackgroundTaskToolInput,
      ctx: ExtensionToolContext,
      signal = new AbortController().signal,
    ) => {
      const tool = Option.getOrUndefined(
        Arr.findLast(host.registrations, ({ name }) => name === "background_task"),
      );
      if (!tool) return Promise.reject(new Error("background_task was not registered"));
      return tool.execute("call", input, signal, undefined, ctx);
    };
    return {
      /** Every registration in order, so a replacement shows as a second one. */
      tools: host.registrations,
      /** The tools registered now, by name. */
      registered: host.tools,
      resolve: host.resolve,
      execute,
      /** Starts a task through the registered tool and returns its id. */
      startTask: (ctx: ExtensionToolContext, input: Omit<BackgroundTaskToolInput, "action">) =>
        Effect.promise(() => execute({ ...input, action: "start" }, ctx)).pipe(
          Effect.map((result) => {
            const details = decodeDetails(result.details);
            if (details.action !== "start") throw new Error("start returned the wrong action");
            return details.snapshot.id;
          }),
        ),
      command: (args: string, ctx: ExtensionCommandContext) => {
        const tasks = host.commands.get("tasks");
        if (!tasks) return Promise.reject(new Error("/tasks was not registered"));
        return Promise.resolve(tasks.handler(args, ctx));
      },
      emit: (name: DefaultedEventName, ctx: ExtensionContext) => host.emit(name, ctx),
      modelContext: host.modelContext,
      /** Settles a completed run through every handler, chaining their results as Pi does. */
      settle: (ctx: ExtensionContext) =>
        Arr.reduce(
          host.handlers.get("agent_before_settle"),
          Promise.resolve(agentBeforeSettleEventFixture()),
          (previous, handler) =>
            previous.then((event) =>
              Promise.resolve(handler(event, ctx)).then((result) => ({
                ...event,
                entries: result?.entries ?? event.entries,
                continue: result?.continue ?? event.continue,
              })),
            ),
        ),
      globalSettings: documents.readObject(settingsPath),
      breakAgentDirectory: documents
        .writeObject(blocker, {})
        .pipe(Effect.andThen(useAgentDirectory(blocker))),
      restoreAgentDirectory: useAgentDirectory(agentDirectory),
    };
  }).pipe(Effect.provide(nodeFilePlatformLayer));
