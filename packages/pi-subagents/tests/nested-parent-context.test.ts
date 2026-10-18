import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  defineTool,
  SessionManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
  temporaryDirectory,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import * as ApplicationLayers from "../src/layer.ts";
import type { BackendDriver, BackendEvent, BackendLaunchRequest } from "../src/backend/model.ts";
import { backendRegistryFor, SubagentBackendRegistry } from "../src/backend/service.ts";
import { createForkedSession } from "../src/boundary/child-process.ts";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import { capturePiParentContext } from "../src/boundary/host-child-pi.ts";
import type { LocalPiChildIpcHandlers } from "../src/boundary/local-pi-ipc.ts";
import { resolveProfileStart } from "../src/boundary/host-profile-resolution.ts";
import { SubagentService } from "../src/run/service.ts";
import { executeSubagentActionEffect } from "../src/tools/execute.ts";
import { encodeSubagentProxyInput, withSubagentProxyParent } from "../src/tools/proxy-protocol.ts";
import type { SubagentToolInput } from "../src/tools/schema.ts";
import { fakeWriterLeaseLayer, profileLayerFor, request } from "./run/fixtures/service-harness.ts";

const rootModel = modelFixture({
  provider: "openai",
  id: "root-model",
  api: "openai-responses",
  reasoning: true,
  contextWindow: 10_000,
});
const childModel = modelFixture({
  ...rootModel,
  id: "child-model",
  contextWindow: 1_000,
  compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
});
const changedChildModel = modelFixture({ ...childModel, id: "changed-child-model" });
const models = [rootModel, childModel, changedChildModel];
const modelRegistry = {
  getAvailable: () => models,
  find: (provider: string, id: string) =>
    models.find((model) => model.provider === provider && model.id === id),
  hasConfiguredAuth: () => true,
  getProviderAuthStatus: () => ({ configured: true, source: "stored" as const }),
};

const contextFor = (session: SessionManager, model = rootModel): ExtensionContext =>
  extensionContextFixture({
    cwd: session.getCwd(),
    signal: undefined,
    hasUI: false,
    mode: "rpc",
    model,
    modelRegistry,
    sessionManager: session,
    isProjectTrusted: () => true,
    getContextUsage: () => ({ tokens: 1, contextWindow: 10_000, percent: 0.01 }),
  });

const backendFixture = (parent: SessionManager) => {
  const launches: BackendLaunchRequest[] = [];
  const controls: Array<{ readonly offer: (event: BackendEvent) => void; released: boolean }> = [];
  const driver = (runtime: BackendDriver["runtime"]): BackendDriver => ({
    runtime,
    capabilities: [],
    supportsContext: () => true,
    preflight: () => Effect.void,
    spawn: (launch) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<BackendEvent, Cause.Done>();
          const session = launches.length === 0 ? parent : SessionManager.inMemory(launch.cwd);
          const control = {
            offer: (event: BackendEvent) => void Queue.offerUnsafe(events, event),
            released: false,
          };
          launches.push(launch);
          controls.push(control);
          return {
            handle: {
              events,
              awaitExit: Effect.never,
              acknowledge: () => {},
              terminate: () => Effect.void,
              cancelPending: () => {},
              controls: {
                initialize: Effect.succeed({
                  model: launch.model,
                  effort: launch.effort,
                  sessionId: session.getSessionId(),
                  ...(runtime === "pi" && { sessionFile: session.getSessionFile() }),
                }),
                start: (_message: string, assignmentEpoch: number) =>
                  Effect.sync(() => control.offer({ type: "run_started", assignmentEpoch })),
                steer: () => Effect.void,
                interrupt: Effect.void,
                reply: () => Effect.void,
                notifyPeers: () => Effect.void,
              },
            },
            release: Effect.sync(() => {
              control.released = true;
              Queue.endUnsafe(events);
            }),
          };
        }),
        ({ release }) => release,
      ).pipe(Effect.map(({ handle }) => handle)),
  });
  return {
    launches,
    controls,
    layer: Layer.succeed(
      SubagentBackendRegistry,
      backendRegistryFor([driver("pi"), driver("claude")]),
    ),
  };
};

const profiles = profileLayerFor({
  version: 6,
  defaultProfileSet: "nested",
  profileSets: {
    nested: {
      profiles: {
        oracle: [0, 1].map(() => ({
          host: "local",
          runtime: "pi",
          model: "parent",
          effort: "default",
          context: "fork",
          writeIntent: "read-only",
        })),
      },
    },
  },
});

const openRoot = (ctx: ExtensionContext, directory: string) =>
  Effect.gen(function* () {
    const captured: ApplicationLayers.SubagentLayerOptions[] = [];
    const makeLayer = ApplicationLayers.subagentApplicationLayer;
    const capture = vi
      .spyOn(ApplicationLayers, "subagentApplicationLayer")
      .mockImplementation((options) => {
        captured.push(options);
        return makeLayer(options);
      });
    const host = recordingExtensionHost(
      {},
      {
        getThinkingLevel: () => "low",
        getActiveTools: () => ["read", "bash"],
      },
    );
    registerSubagentApplication(host.pi, {
      loadSettings: () => Promise.resolve(),
      getAgentDirectory: () => directory,
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => Promise.resolve(host.emit("session_shutdown", ctx))).pipe(
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => capture.mockRestore())),
      ),
    );
    yield* Effect.tryPromise(() => Promise.resolve(host.emit("session_start", ctx)));
    const activation = captured[0];
    if (!activation) return yield* Effect.die("Root did not activate");
    return { host, activation };
  });

describe("authenticated immediate-parent context", () => {
  it.live(
    "uses the child model, effort and findings through public proxy wiring and root-issued retry",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory("pi-nested-parent-");
        const root = SessionManager.create(directory, directory);
        root.appendMessage({ role: "user", content: "ROOT-ONLY-HISTORY", timestamp: 1 });
        root.appendMessage(fauxAssistantMessage("Root answer"));
        const child = SessionManager.create(directory, directory);
        child.appendMessage({ role: "user", content: "Child assignment", timestamp: 2 });
        child.appendMessage(fauxAssistantMessage("CHILD-FINDINGS"));
        const findingsLeaf = child.appendMessage({
          role: "toolResult",
          toolCallId: "inspect",
          toolName: "read",
          content: [{ type: "text", text: "CHILD-VERIFICATION" }],
          isError: false,
          timestamp: 3,
        });
        child.appendMessage(fauxAssistantMessage(""));
        const rootCtx = contextFor(root);
        const { host: rootHost, activation } = yield* openRoot(rootCtx, directory);
        const backend = backendFixture(child);
        const layer = SubagentService.layer({ proxyHandler: activation.proxyHandler }).pipe(
          Layer.provideMerge(backend.layer),
          Layer.provideMerge(profiles),
          Layer.provide(fakeWriterLeaseLayer()),
        );
        yield* Effect.gen(function* () {
          const service = yield* SubagentService;
          const parent = yield* service.start(
            request({ cwd: directory, model: "openai/child-model", effort: "medium" }),
          );
          const parentControl = backend.controls[0];
          if (!parentControl) return yield* Effect.die("Parent did not launch");
          let listener: LocalPiChildIpcHandlers | undefined;
          let selectedModel: ReturnType<typeof modelFixture> | undefined = childModel;
          let effort: "medium" | "minimal" = "medium";
          let tokens = 10;
          const childCtx = contextFor(child, childModel);
          const liveCtx = extensionContextFixture({
            ...childCtx,
            get model() {
              return selectedModel;
            },
            getContextUsage: () => ({
              tokens,
              contextWindow: selectedModel?.contextWindow ?? 1_000,
              percent: 1,
            }),
          });
          const childTools = new Map<string, ToolDefinition>();
          const childHost = recordingExtensionHost(
            {},
            {
              getThinkingLevel: () => effort,
              getActiveTools: () => ["child-only-tool"],
              registerTool: (tool) => void childTools.set(tool.name, defineTool(tool)),
            },
          );
          registerSubagentChildBridge(childHost.pi, {
            loadSettings: () => Promise.resolve(),
            openIpc: () => ({
              listen: (handlers) => {
                listener = handlers;
                return () => {
                  listener = undefined;
                };
              },
              sendContact: (contact) =>
                Effect.sync(() => {
                  if (contact.type !== "proxy_request") return;
                  parentControl.offer({
                    ...contact,
                    respond: (ok, payloadJson) =>
                      Effect.sync(() => {
                        listener?.onControl({
                          channel: "pi-subagents",
                          type: "proxy_response",
                          requestId: contact.requestId,
                          ok,
                          payloadJson,
                        });
                      }),
                  });
                }),
            }),
          });
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise(() =>
              Promise.resolve(childHost.emit("session_shutdown", liveCtx)),
            ).pipe(Effect.ignore),
          );
          yield* Effect.tryPromise(() => Promise.resolve(childHost.emit("session_start", liveCtx)));
          const call = (input: SubagentToolInput) =>
            Effect.tryPromise(() => {
              const tool = childTools.get(input.tool);
              if (!tool) throw new Error(`Missing child tool ${input.tool}`);
              return tool.execute("nested-call", input.args, undefined, undefined, liveCtx);
            });
          yield* call({
            tool: "subagent_start",
            args: { agents: [{ task: "Reconstruct decisions", profile: "oracle" }] },
          });
          const oracle = backend.launches[1];
          if (!oracle) return yield* Effect.die("Oracle did not launch");
          expect(oracle).toMatchObject({
            model: "openai/child-model",
            effort: "high",
            context: "fork",
            parentSessionId: child.getSessionId(),
            parentSessionFile: child.getSessionFile(),
            parentLeafId: findingsLeaf,
            sharesParentPromptCache: true,
            activeTools: ["read", "bash"],
          });
          const fork = SessionManager.open(yield* createForkedSession(oracle, directory));
          const inherited = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            fork.buildSessionContext().messages,
          );
          expect(inherited).toContain("CHILD-FINDINGS");
          expect(inherited).toContain("CHILD-VERIFICATION");
          expect(inherited).not.toContain("ROOT-ONLY-HISTORY");
          expect((yield* service.list).find((run) => run.id === oracle.runId)?.parentRunId).toBe(
            parent.id,
          );

          const latestLeaf = child.appendMessage({
            role: "user",
            content: "LATEST-CHILD-FINDING",
            timestamp: 4,
          });
          selectedModel = changedChildModel;
          effort = "minimal";
          yield* call({
            tool: "subagent_start",
            args: { agents: [{ task: "Continue bounded analysis" }] },
          });
          expect(backend.launches[2]).toMatchObject({
            model: "openai/changed-child-model",
            effort: "minimal",
          });
          tokens = 900;
          const oversized = yield* call({
            tool: "subagent_start",
            args: { agents: [{ task: "Too much context", profile: "oracle" }] },
          });
          expect(oversized.structuredContent).toMatchObject({
            outcome: "failed",
            launches: [{ failure: { code: "profile_no_eligible_model" } }],
          });
          expect(backend.launches).toHaveLength(3);
          tokens = 10;
          // Refresh native facts without launching, then let the root retry the failed grandchild.
          yield* call({ tool: "subagent_models", args: {} });
          const oracleControl = backend.controls[1];
          if (!oracleControl) return yield* Effect.die("Missing oracle control");
          oracleControl.offer({ type: "protocol_error", message: "Fixture oracle failure" });
          yield* service.withAwaitTerminalObservations(
            [oracle.runId],
            "all_finished",
            undefined,
            () => Effect.void,
          );
          yield* service.stop(oracle.runId);
          expect(oracleControl.released).toBe(true);
          const retried = yield* executeSubagentActionEffect(
            rootHost.pi,
            { cwd: directory, projectTrusted: true },
            { tool: "subagent_lifecycle", args: { action: "retry", runIds: [oracle.runId] } },
            undefined,
            rootCtx,
          );
          expect(retried.isError).not.toBe(true);
          expect(backend.launches[3]).toMatchObject({
            model: "openai/changed-child-model",
            effort: "high",
            parentSessionId: child.getSessionId(),
            parentSessionFile: child.getSessionFile(),
            parentLeafId: latestLeaf,
            sharesParentPromptCache: true,
          });
          selectedModel = undefined;
          const missingModel = yield* call({
            tool: "subagent_start",
            args: { agents: [{ task: "No selected parent model" }] },
          });
          expect(missingModel.structuredContent).toMatchObject({ outcome: "failed" });
          expect(backend.launches).toHaveLength(4);
          yield* executeSubagentActionEffect(
            rootHost.pi,
            { cwd: directory, projectTrusted: true },
            {
              tool: "subagent_start",
              args: { agents: [{ task: "Root still inherits its own context" }] },
            },
            undefined,
            rootCtx,
          );
          expect(backend.launches[4]).toMatchObject({
            model: "openai/root-model",
            effort: "low",
            parentSessionId: root.getSessionId(),
          });
          return undefined;
        }).pipe(Effect.provide(layer));
      }),
  );

  it.live("never substitutes root fork context for an uncaptured Pi or non-Pi parent", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-nested-no-root-");
      const root = SessionManager.create(directory, directory);
      root.appendMessage({ role: "user", content: "Root is persistable", timestamp: 1 });
      root.appendMessage(fauxAssistantMessage("Root answer"));
      const child = SessionManager.create(directory, directory);
      const rootCtx = contextFor(root);
      const { host, activation } = yield* openRoot(rootCtx, directory);
      const backend = backendFixture(child);
      const layer = SubagentService.layer({ proxyHandler: activation.proxyHandler }).pipe(
        Layer.provideMerge(backend.layer),
        Layer.provideMerge(profiles),
        Layer.provide(fakeWriterLeaseLayer()),
      );
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const parent = yield* service.start(
          request({ cwd: directory, model: "openai/child-model" }),
        );
        const native = yield* service.start(
          request({ cwd: directory, runtime: "claude", model: "native-model" }),
        );
        for (const run of [parent, native]) {
          const environment = yield* service.captureLaunchParent(run.id);
          const failure = yield* resolveProfileStart(
            host.pi,
            { task: "Must not inherit root", profile: "oracle" },
            rootCtx,
            { ...environment, projectTrusted: true },
          ).pipe(Effect.flip);
          expect(failure).toMatchObject({ code: "fork_context_unavailable" });
          expect(environment.parentContext.sessionFile).toBeUndefined();
        }
        const childContext = capturePiParentContext(host.pi, contextFor(child, childModel));
        for (const forged of [
          { ...childContext, sessionId: root.getSessionId() },
          { ...childContext, sessionFile: root.getSessionFile() },
        ]) {
          const failure = yield* service.captureLaunchParent(parent.id, forged).pipe(Effect.flip);
          expect(failure).toMatchObject({ code: "parent_context_mismatch" });
        }
        const rejected = yield* service
          .captureLaunchParent(native.id, childContext)
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({ code: "parent_context_mismatch" });
        const ephemeral = yield* service.start(
          request({ cwd: directory, model: "openai/child-model" }),
        );
        const ephemeralParent = yield* service.captureLaunchParent(ephemeral.id);
        const unregisteredFile = yield* service
          .captureLaunchParent(ephemeral.id, {
            ...childContext,
            sessionId: ephemeralParent.parentContext.sessionId,
            sessionFile: root.getSessionFile(),
          })
          .pipe(Effect.flip);
        expect(unregisteredFile).toMatchObject({ code: "parent_context_mismatch" });
        // Authenticated requests without native facts also stay non-forkable at the public handler.
        const bare = yield* activation.proxyHandler(service, parent.id, {
          requestId: "no-parent-context",
          ...encodeSubagentProxyInput({
            tool: "subagent_start",
            args: { agents: [{ task: "Missing context", profile: "oracle" }] },
          }),
        });
        expect(bare.structuredContent).toMatchObject({
          outcome: "failed",
          launches: [{ failure: { code: "fork_context_unavailable" } }],
        });
        const forged = yield* activation
          .proxyHandler(service, parent.id, {
            requestId: "foreign-session",
            ...withSubagentProxyParent(
              encodeSubagentProxyInput({ tool: "subagent_models", args: {} }),
              { ...childContext, sessionId: root.getSessionId() },
            ),
          })
          .pipe(Effect.flip);
        expect(forged).toMatchObject({ code: "parent_context_mismatch" });
        expect(backend.launches).toHaveLength(3);
      }).pipe(Effect.provide(layer));
    }),
  );
});
