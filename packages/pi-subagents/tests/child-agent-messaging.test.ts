import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createEventBus,
  defineTool,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  deferredPromise,
  recordingExtensionHost,
  temporaryDirectory,
} from "pi-cosmic-core/testing";
import {
  queryQuestionnaireRelay,
  type AskUserOutcome,
  type QuestionnaireOwner,
} from "pi-ask-user/protocol";
import { vi } from "vitest";
import { registerSubagentChildBridge } from "../src/boundary/host-child.ts";
import { SubagentService } from "../src/run/service.ts";
import { AGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";
import { decodeSubagentContract } from "../src/tools/contract-schema.ts";
import { encodeSubagentProxyInput, withSubagentProxyParent } from "../src/tools/proxy-protocol.ts";
import type { AgentToolInput } from "../src/tools/schema.ts";
import { sessionContextFixture } from "./fixtures/pi-host.ts";
import {
  activateRoot,
  proxyBackend,
  proxyIpcChannel,
  proxyServiceLayer,
} from "./fixtures/proxy-parent.ts";
import { request } from "./run/fixtures/service-harness.ts";
import { eventLoopTurn, step } from "./support/effect-test.ts";
import { answerCapabilityQueries, pickQuestionnaire } from "./support/questionnaire.ts";
import * as Arr from "effect/Array";

// A few event-loop turns: long enough for a stray notice to cross the channel.
const eventLoopTurns = () => eventLoopTurn().then(eventLoopTurn).then(eventLoopTurn);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const contextFor = (session: SessionManager) =>
  sessionContextFixture({ cwd: session.getCwd(), sessionManager: session });

const openRoot = (ctx: ExtensionContext, directory: string) =>
  Effect.gen(function* () {
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    const events = createEventBus();
    const host = recordingExtensionHost(
      {},
      { getActiveTools: () => ["read"], sendMessage, events },
    );
    return { activation: yield* activateRoot(host, ctx, directory), sendMessage, events };
  });

// A child bridge whose IPC requests reach the root through its run's authenticated channel.
const openChild = (
  control: ReturnType<typeof proxyBackend>["controls"][number],
  session: SessionManager,
  activeTools: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const ctx = contextFor(session);
    const tools = new Map<string, ToolDefinition>();
    let active = [...activeTools];
    const events = createEventBus();
    const host = recordingExtensionHost(
      {},
      {
        events,
        getActiveTools: () => [...active],
        setActiveTools: (names: ReadonlyArray<string>) => {
          active = [...names];
        },
        registerTool: (tool) => void tools.set(tool.name, defineTool(tool)),
      },
    );
    registerSubagentChildBridge(host.pi, {
      loadSettings: () => Promise.resolve(),
      openIpc: () => proxyIpcChannel(control.offer),
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
    return { activeTools: () => [...active], call, events, refusal };
  });

describe("Pi child agent messaging through the root coordinator", () => {
  it.live("lists agents, messages a sibling and main, and reads main as itself", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-child-agent-messaging-");
      const root = SessionManager.create(directory, directory);
      root.appendMessage({ role: "user", content: "Coordinate the review", timestamp: 1 });
      root.appendMessage(fauxAssistantMessage("MAIN-LATEST-FINDING"));
      const { activation, sendMessage } = yield* openRoot(contextFor(root), directory);
      const backend = proxyBackend();
      const layer = proxyServiceLayer(
        { proxyHandler: activation.proxyHandler, agentMain: activation.agentMain },
        backend,
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
      const backend = proxyBackend();
      const layer = proxyServiceLayer(
        { proxyHandler: activation.proxyHandler, agentMain: activation.agentMain },
        backend,
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

describe("Pi child questionnaires through the root coordinator", () => {
  it.live("shows a relayed questionnaire as waiting only once the root has it on screen", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-child-questionnaire-");
      const root = SessionManager.create(directory, directory);
      const { activation, events } = yield* openRoot(contextFor(root), directory);
      // The root's questionnaire: the test decides when each request reaches the screen.
      const asked: Array<{
        readonly owner: QuestionnaireOwner;
        readonly shown: () => void;
        readonly answer: (outcome: AskUserOutcome) => void;
      }> = [];
      answerCapabilityQueries(events, () => ({
        version: 1,
        sessionId: root.getSessionId(),
        generation: "root",
        cancel: () => Promise.resolve(),
        ask: (_request, owner, _signal, shown) => {
          const reply = deferredPromise<AskUserOutcome>();
          asked.push({ owner, shown: shown ?? (() => undefined), answer: reply.resolve });
          return reply.promise;
        },
      }));
      const backend = proxyBackend();
      const layer = proxyServiceLayer(
        {
          proxyHandler: activation.proxyHandler,
          questionnaireHandler: activation.questionnaireHandler,
        },
        backend,
      );
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(request({ cwd: directory, name: "asker" }));
        const [control] = backend.controls;
        if (!control) return yield* Effect.die("Run did not launch");
        const session = SessionManager.inMemory(directory);
        const child = yield* openChild(control, session, ["read"]);
        const relay = queryQuestionnaireRelay(child.events, session.getSessionId());
        assert(relay !== undefined);
        // Both of the child's asks wait in the root's queue until it opens them.
        const shown: string[] = [];
        const ask = (key: string) =>
          Promise.resolve<unknown>(
            relay.ask(
              { questions: [{ ...pickQuestionnaire.questions[0]!, key }] },
              new AbortController().signal,
              () => void shown.push(key),
            ),
          );
        const first = ask("first");
        const second = ask("second");
        yield* step(() => vi.waitFor(() => expect(asked).toHaveLength(2)));
        const [opened, queued] = asked;
        assert(opened !== undefined && queued !== undefined);
        expect(opened.owner.runId).toBe(run.id);
        yield* step(eventLoopTurns);
        expect(shown).toEqual([]);

        // Opening one reports it once, however often the root repeats itself.
        opened.shown();
        opened.shown();
        yield* step(() => vi.waitFor(() => expect(shown).toEqual(["first"])));
        yield* step(eventLoopTurns);
        expect(shown).toEqual(["first"]);

        // A report after the answer arrives too late to change anything.
        const answer: AskUserOutcome = { outcome: "cancelled", answers: [] };
        opened.answer(answer);
        expect(yield* step(() => first)).toEqual(answer);
        queued.answer(answer);
        expect(yield* step(() => second)).toEqual(answer);
        opened.shown();
        queued.shown();
        yield* step(eventLoopTurns);
        expect(shown).toEqual(["first"]);
        return undefined;
      }).pipe(Effect.provide(layer));
    }),
  );
});
