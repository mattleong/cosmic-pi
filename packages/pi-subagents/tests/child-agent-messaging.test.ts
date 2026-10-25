import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  defineTool,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  extensionContextFixture,
  recordingExtensionHost,
  temporaryDirectory,
} from "pi-cosmic-core/testing";
import { vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import * as ApplicationLayers from "../src/layer.ts";
import type { BackendDriver, BackendEvent } from "../src/backend/model.ts";
import { backendRegistryFor, SubagentBackendRegistry } from "../src/backend/service.ts";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import type { LocalPiChildIpcHandlers } from "../src/boundary/local-pi-ipc.ts";
import { PI_SUBAGENT_CAPABILITIES } from "../src/run/model.ts";
import { SubagentService } from "../src/run/service.ts";
import { AGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";
import { decodeSubagentContract } from "../src/tools/contract-schema.ts";
import { encodeSubagentProxyInput, withSubagentProxyParent } from "../src/tools/proxy-protocol.ts";
import type { AgentToolInput } from "../src/tools/schema.ts";
import { fakeWriterLeaseLayer, profileLayerFor, request } from "./run/fixtures/service-harness.ts";
import { step } from "./support/effect-test.ts";
import * as Arr from "effect/Array";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const contextFor = (session: SessionManager) =>
  extensionContextFixture({
    cwd: session.getCwd(),
    signal: undefined,
    hasUI: false,
    mode: "rpc",
    sessionManager: session,
    isProjectTrusted: () => true,
  });

// Every run is a live Pi child whose steering input the test observes.
const backendFixture = () => {
  const controls: Array<{
    readonly runId: string;
    readonly steered: string[];
    readonly offer: (event: BackendEvent) => void;
  }> = [];
  const driver: BackendDriver = {
    capabilities: PI_SUBAGENT_CAPABILITIES,
    supportsContext: () => true,
    preflight: () => Effect.void,
    spawn: (launch) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<BackendEvent, Cause.Done>();
          const session = SessionManager.inMemory(launch.cwd);
          const control = {
            runId: launch.runId,
            steered: new Array<string>(),
            offer: (event: BackendEvent) => void Queue.offerUnsafe(events, event),
          };
          controls.push(control);
          return {
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
              }),
              start: (_message: string, assignmentEpoch: number) =>
                Effect.sync(() => control.offer({ type: "run_started", assignmentEpoch })),
              steer: (message: string) => Effect.sync(() => void control.steered.push(message)),
              interrupt: Effect.void,
              reply: () => Effect.void,
              notifyPeers: () => Effect.void,
            },
          };
        }),
        (handle) => Effect.sync(() => Queue.endUnsafe(handle.events)),
      ),
  };
  return {
    controls,
    layer: Layer.succeed(SubagentBackendRegistry, backendRegistryFor(driver)),
  };
};

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
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const host = recordingExtensionHost({}, { getActiveTools: () => ["read"], sendMessage });
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
    return { activation, sendMessage };
  });

// A child bridge whose IPC requests reach the root through its run's authenticated channel.
const openChild = (
  control: ReturnType<typeof backendFixture>["controls"][number],
  session: SessionManager,
  activeTools: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const ctx = contextFor(session);
    const tools = new Map<string, ToolDefinition>();
    let active = [...activeTools];
    let listener: LocalPiChildIpcHandlers | undefined;
    const host = recordingExtensionHost(
      {},
      {
        getActiveTools: () => [...active],
        setActiveTools: (names: ReadonlyArray<string>) => {
          active = [...names];
        },
        registerTool: (tool) => void tools.set(tool.name, defineTool(tool)),
      },
    );
    registerSubagentChildBridge(host.pi, {
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
            control.offer({
              ...contact,
              respond: (ok, payloadJson) =>
                Effect.sync(() =>
                  listener?.onControl({
                    channel: "pi-subagents",
                    type: "proxy_response",
                    requestId: contact.requestId,
                    ok,
                    payloadJson,
                  }),
                ),
            });
          }),
      }),
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => Promise.resolve(host.emit("session_shutdown", ctx))).pipe(
        Effect.ignore,
      ),
    );
    yield* Effect.tryPromise(() => Promise.resolve(host.emit("session_start", ctx)));
    let calls = 0;
    // Pi announces each call before executing it; a parent call ID marks a script's call.
    const execute = (input: AgentToolInput, parentToolCallId?: string) =>
      Effect.gen(function* () {
        const tool = tools.get(input.tool);
        if (!tool) return yield* Effect.die(`Missing child tool ${input.tool}`);
        const toolCallId = `call-${++calls}`;
        const announced = {
          toolCallId,
          toolName: input.tool,
          ...(parentToolCallId && { parentToolCallId }),
        };
        yield* step(() =>
          host.emit("tool_execution_start", ctx, {
            type: "tool_execution_start",
            ...announced,
            args: input.args,
          }),
        );
        yield* step(() =>
          host.emit("tool_call", ctx, { type: "tool_call", ...announced, input: input.args }),
        );
        return () => tool.execute(toolCallId, input.args, undefined, undefined, ctx);
      });
    const call = (input: AgentToolInput) => execute(input).pipe(Effect.flatMap(step));
    // The refusal text a failed call reports to the model.
    const refusal = (input: AgentToolInput, parentToolCallId?: string) =>
      execute(input, parentToolCallId).pipe(
        Effect.flatMap((run) =>
          step(() =>
            run().then(
              () => undefined,
              (cause: unknown) => (cause instanceof Error ? cause.message : undefined),
            ),
          ),
        ),
      );
    return { activeTools: () => [...active], call, refusal };
  });

describe("Pi child agent messaging through the root coordinator", () => {
  it.live("lists agents, messages a sibling and main, and reads main as itself", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-child-agent-messaging-");
      const root = SessionManager.create(directory, directory);
      root.appendMessage({ role: "user", content: "Coordinate the review", timestamp: 1 });
      root.appendMessage(fauxAssistantMessage("MAIN-LATEST-FINDING"));
      const { activation, sendMessage } = yield* openRoot(contextFor(root), directory);
      const backend = backendFixture();
      const layer = SubagentService.layer({
        proxyHandler: activation.proxyHandler,
        agentMain: activation.agentMain,
      }).pipe(
        Layer.provideMerge(backend.layer),
        Layer.provideMerge(profileLayerFor({})),
        Layer.provide(fakeWriterLeaseLayer()),
      );
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const caller = yield* service.start(request({ cwd: directory, name: "api-scout" }));
        const sibling = yield* service.start(request({ cwd: directory, name: "db-scout" }));
        const [callerControl, siblingControl] = backend.controls;
        if (!callerControl || !siblingControl) return yield* Effect.die("Runs did not launch");
        const child = yield* openChild(callerControl, SessionManager.inMemory(directory), ["read"]);
        expect(child.activeTools()).toEqual(expect.arrayContaining([...AGENT_TOOL_NAMES]));

        const listed = yield* child.call({ tool: "agent_list", args: {} });
        const agents = decodeSubagentContract("agent_list")(listed.structuredContent)?.agents;
        expect(agents).toHaveLength(3);
        assert(agents !== undefined);
        expect(Arr.map(agents, ({ id, self }) => ({ id, self }))).toEqual(
          expect.arrayContaining([
            { id: "main", self: false },
            { id: caller.id, self: true },
            { id: sibling.id, self: false },
          ]),
        );

        const guided = yield* child.call({
          tool: "agent_send",
          args: { to: sibling.id, message: "Which table holds sessions?" },
        });
        expect(guided.details).toMatchObject({ to: sibling.id, disposition: "guided" });
        // The root writes the sender label from the authenticated channel.
        expect(Arr.join(siblingControl.steered, "\n")).toContain(caller.id);
        expect(Arr.join(siblingControl.steered, "\n")).toContain("Which table holds sessions?");

        const woken = yield* child.call({
          tool: "agent_send",
          args: { to: "main", message: "Found the session table." },
        });
        expect(woken.details).toMatchObject({
          to: "main",
          disposition: "guided",
          mainState: "idle",
        });
        const [delivered, delivery] = sendMessage.mock.calls[0] ?? [];
        expect(delivered).toMatchObject({ details: { from: caller.id, to: "main" } });
        expect(delivered?.content).toContain(caller.id);
        expect(delivery).toMatchObject({ triggerTurn: true });

        const read = yield* child.call({ tool: "agent_read", args: { agentIds: ["main"] } });
        expect(read.structuredContent).toMatchObject({
          tool: "agent_read",
          agents: [{ id: "main", kind: "main", text: "MAIN-LATEST-FINDING" }],
        });

        const proxied = callerControl.steered.length;
        const scripted = yield* child.refusal(
          { tool: "agent_send", args: { to: "main", message: "From a script" } },
          "script",
        );
        expect(scripted).toMatch(/scripted_agent_send_not_supported/u);
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(callerControl.steered).toHaveLength(proxied);

        // The caller is the authenticated run, so it cannot message itself as a peer.
        const self = yield* child.refusal({
          tool: "agent_send",
          args: { to: caller.id, message: "Hello me" },
        });
        expect(self).toMatch(/agent_self_target/u);
        return undefined;
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("rejects agent payloads that name a caller, ancestry, or parent context", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-child-agent-forgery-");
      const root = SessionManager.create(directory, directory);
      const { activation } = yield* openRoot(contextFor(root), directory);
      const backend = backendFixture();
      const layer = SubagentService.layer({
        proxyHandler: activation.proxyHandler,
        agentMain: activation.agentMain,
      }).pipe(
        Layer.provideMerge(backend.layer),
        Layer.provideMerge(profileLayerFor({})),
        Layer.provide(fakeWriterLeaseLayer()),
      );
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const caller = yield* service.start(request({ cwd: directory }));
        const victim = yield* service.start(request({ cwd: directory }));
        const forgedPayloads = [
          {
            tool: "agent_send",
            argumentsJson: encodeJson({ to: "main", message: "Hi", from: victim.id }),
          },
          {
            tool: "agent_send",
            argumentsJson: encodeJson({
              to: "main",
              message: "Hi",
              caller: { kind: "run", runId: victim.id },
            }),
          },
          {
            tool: "agent_list",
            argumentsJson: encodeJson({ parentRunId: victim.id }),
          },
          withSubagentProxyParent(encodeSubagentProxyInput({ tool: "agent_list", args: {} }), {
            sessionId: root.getSessionId(),
            effort: "high",
          }),
        ];
        for (const [index, payload] of forgedPayloads.entries()) {
          const failure = yield* activation
            .proxyHandler(service, caller.id, { requestId: `forged-${index}`, ...payload })
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ code: "proxy_request_invalid" });
        }
        // A well-formed request still speaks only for the authenticated run.
        const listed = yield* activation.proxyHandler(service, caller.id, {
          requestId: "bound",
          ...encodeSubagentProxyInput({ tool: "agent_list", args: { agentIds: [victim.id] } }),
        });
        expect(listed.structuredContent).toMatchObject({
          agents: [{ id: victim.id, self: false }],
        });
        return undefined;
      }).pipe(Effect.provide(layer));
    }),
  );
});
