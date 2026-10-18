import {
  createEventBus,
  type AgentToolResult,
  type ExtensionHandler,
  type ToolDefinition,
  type ToolResultEvent,
  type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { JsonObject } from "pi-cosmic-core";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
  type DefaultedEventName,
  type ExtensionEventName,
  type ExtensionEventNamed,
  type RecordedHandlers,
} from "pi-cosmic-core/testing";
import { expect } from "vitest";
import { effectTest, step } from "../support/effect-test.ts";
import { registerSubagentErrorReceipts } from "../../src/boundary/host-tool-result.ts";
import { InvalidSubagentRequestError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
import type { SubagentToolRuntime } from "../../src/tools/execute.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  executeTool,
  fallbackProfileService,
  testBackendRegistry,
  view,
} from "./fixtures/tool-harness.ts";

type ToolResultHandler = ExtensionHandler<ToolResultEvent, ToolResultEventResult>;
type Tool = ToolDefinition;
const toolHosts = new WeakMap<Tool, RecordedHandlers>();
const runHooks = <Name extends ExtensionEventName>(
  hooks: RecordedHandlers | undefined,
  name: Name,
  event: ExtensionEventNamed<Name>,
) =>
  Effect.forEach(hooks?.get(name) ?? [], (hook) => step(() => Promise.resolve(hook(event, ctx))));
const execute = (tool: Tool, args: JsonObject, options?: Parameters<typeof executeTool>[2]) =>
  Effect.gen(function* () {
    const hooks = toolHosts.get(tool);
    const call = { toolName: tool.name, toolCallId: options?.callID ?? "call" };
    yield* runHooks(hooks, "tool_execution_start", { type: "tool_execution_start", ...call, args });
    const admission: ExtensionEventNamed<"tool_call"> = { type: "tool_call", ...call, input: args };
    for (const hook of hooks?.get("tool_call") ?? []) {
      const result = yield* step(() => Promise.resolve(hook(admission, ctx)));
      if (result?.block) return yield* Effect.die(new Error(result.reason));
    }
    return yield* step(() => executeTool(tool, args, options));
  });
const ctx = extensionContextFixture({
  cwd: process.cwd(),
  hasUI: false,
  mode: "rpc",
  signal: undefined,
  isProjectTrusted: () => false,
  sessionManager: { getSessionId: () => "tool-results-test" },
});

function host() {
  const {
    pi,
    handlers: hooks,
    tools,
    emit: emitEvent,
  } = recordingExtensionHost(
    {},
    {
      events: createEventBus(),
      registerFlag: () => undefined,
      registerProvider: () => undefined,
      getFlag: (name: string) => (name === "pi-subagents-supervisor-config" ? "/unused" : false),
    },
  );
  const emit = (name: DefaultedEventName) => step(() => emitEvent(name, ctx));
  const result = (event: ToolResultEvent) =>
    Effect.gen(function* () {
      let current = event;
      for (const handler of hooks.get("tool_result") ?? []) {
        const patch = yield* step(() => Promise.resolve(handler(current, ctx)));
        if (patch !== undefined) current = Object.assign({}, current, patch);
      }
      return current;
    });
  const dispatch = <Name extends ExtensionEventName>(
    name: Name,
    event: ExtensionEventNamed<Name>,
  ) => step(() => Promise.resolve(hooks.get(name)[0]!(event, ctx)));
  const startCall = (
    toolCallId: string,
    extra: { readonly toolName?: string; readonly parentToolCallId?: string } = {},
  ) =>
    dispatch("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId,
      toolName: "subagent_start",
      args: {},
      ...extra,
    });
  const admitCall = (
    toolCallId: string,
    extra: { readonly input?: JsonObject; readonly parentToolCallId?: string } = {},
  ) =>
    dispatch("tool_call", {
      type: "tool_call",
      toolCallId,
      toolName: "subagent_start",
      input: {},
      ...extra,
    });
  return { pi, hooks, tools, emit, result, dispatch, startCall, admitCall };
}

function receiptHost(earlierResult?: ToolResultHandler) {
  const h = host();
  if (earlierResult) h.pi.on("tool_result", earlierResult);
  const receipts = registerSubagentErrorReceipts(h.pi);
  return { ...h, receipts, owner: receipts.activate() };
}

const proxiedTools = (
  h: ReturnType<typeof receiptHost>,
  proxyCall: NonNullable<SubagentToolRuntime["proxyCall"]>,
) =>
  registerSubagentTools(
    h.pi,
    {
      environment: { cwd: "/project", projectTrusted: false },
      proxyCall,
      run: () => Promise.reject(new Error("proxy only")),
    },
    { receipts: h.receipts, owner: h.owner },
  );

const event = (
  response: AgentToolResult<unknown>,
  toolName = "subagent_send",
  toolCallId = "call",
): ToolResultEvent => ({
  type: "tool_result",
  toolName,
  toolCallId,
  input: {},
  isError: false,
  ...response,
});
const failure = (code = "claude_steering_outcome_uncertain", id = "uncertain") => ({
  id,
  code,
  message: "Input may already have been sent. Do not resend this guidance.",
});
const failed = () => ({
  content: [{ type: "text" as const, text: "exact failure and no-resend evidence" }],
  details: compactToolDetails({ action: "send", runs: [], actionFailures: [failure()] }),
});

function ownedTools(service = subagentServiceDouble({}), earlierResult?: ToolResultHandler) {
  const h = receiptHost(earlierResult);
  registerSubagentTools(
    h.pi,
    {
      environment: { cwd: "/project", projectTrusted: false },
      run: (effect, signal) =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(SubagentService, service),
            Effect.provideService(SubagentProfileService, fallbackProfileService),
            Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
          ),
          signal ? { signal } : undefined,
        ),
    },
    { receipts: h.receipts, owner: h.owner },
  );
  for (const tool of h.tools.values()) toolHosts.set(tool, h.hooks);
  return h;
}

effectTest("fails closed on unknown origin and releases aborted call provenance", function* () {
  const { receipts, owner, startCall, admitCall, dispatch } = receiptHost();
  const admit = (id: string, nested = true) =>
    admitCall(id, {
      input: { parentToolCallId: "argument-does-not-authorize" },
      ...(nested && { parentToolCallId: "native-parent" }),
    });
  expect(receipts.isNested(owner, "unknown")).toBe(true);
  yield* startCall("codemode-looking-model-id");
  expect(receipts.isNested(owner, "codemode-looking-model-id")).toBe(true);
  yield* admit("codemode-looking-model-id", false);
  expect(receipts.isNested(owner, "codemode-looking-model-id")).toBe(false);
  for (let i = 0; i < 255; i++)
    yield* startCall(`pending-${i}`, { parentToolCallId: "native-parent" });
  yield* startCall("over-cap", { parentToolCallId: "" });
  expect(yield* admit("over-cap", false)).toMatchObject({ block: true });
  yield* dispatch("tool_execution_end", {
    type: "tool_execution_end",
    toolName: "subagent_start",
    toolCallId: "pending-0",
    isError: true,
    result: {},
  });
  expect(yield* admit("over-cap", false)).toBeUndefined();
  expect(receipts.isNested(owner, "over-cap")).toBe(true);
  receipts.activate();
  expect(receipts.isNested(owner, "codemode-looking-model-id")).toBe(true);
});

effectTest(
  "keeps empty-parent and missing-start origins scripted across later root-looking events",
  function* () {
    const { receipts, owner, startCall, admitCall } = receiptHost();
    yield* startCall("opaque", { parentToolCallId: "" });
    yield* admitCall("opaque");
    expect(receipts.isNested(owner, "opaque")).toBe(true);
    yield* startCall("opaque");
    yield* admitCall("opaque");
    expect(receipts.isNested(owner, "opaque")).toBe(true);

    yield* admitCall("missing-start");
    expect(receipts.isNested(owner, "missing-start")).toBe(true);
    yield* startCall("missing-start");
    yield* admitCall("missing-start");
    expect(receipts.isNested(owner, "missing-start")).toBe(true);
  },
);

for (const reset of ["activation", "agent_end"] as const)
  effectTest(`does not grant model origin after ${reset} loses start evidence`, function* () {
    const h = receiptHost();
    yield* h.startCall("pending");
    const currentOwner = reset === "activation" ? h.receipts.activate() : h.owner;
    if (reset === "agent_end") yield* h.emit("agent_end");
    yield* h.admitCall("pending");
    expect(h.receipts.isNested(currentOwner, "pending")).toBe(true);
    expect(h.receipts.isNested(h.owner, "pending")).toBe(true);
  });

effectTest(
  "marks all-failed and mixed registered executions without losing evidence or content middleware",
  function* () {
    const h = ownedTools(
      subagentServiceDouble({
        send: (id) =>
          id === "good"
            ? Effect.succeed({ delivery: "guided" as const, run: view({ id }) })
            : Effect.fail(
                new InvalidSubagentRequestError(
                  failure(
                    id === "uncertain" ? "claude_steering_outcome_uncertain" : "not_running",
                    id,
                  ),
                ),
              ),
      }),
    );
    for (const ids of [["bad"], ["uncertain"], ["good", "uncertain"], ["good", "bad"], ["good"]]) {
      const response = yield* execute(h.tools.get("subagent_send")!, {
        runIds: ids,
        message: "guidance",
      });
      const patchedContent = [
        { type: "text" as const, text: "prior middleware content" },
        ...response.content,
      ];
      const original = event({ ...response, content: patchedContent });
      const patched = yield* h.result(original);
      expect(patched.isError).toBe(ids.some((id) => id !== "good"));
      expect(patched.details).toBe(response.details);
      expect(patched.content).toBe(patchedContent);
      expect(yield* h.result(original)).toEqual(original);
    }
  },
);

effectTest("retains only final resolved results and rejects stale late completions", function* () {
  const h = receiptHost();
  const pending = deferredPromise<AgentToolResult<unknown>>();
  proxiedTools(h, () => pending.promise);
  const response = failed();
  const executing = executeTool(h.tools.get("subagent_send")!, {
    runIds: ["uncertain"],
    message: "once",
  });
  expect((yield* h.result(event(response))).isError).toBe(false);
  h.receipts.activate();
  pending.resolve(response);
  expect(yield* step(() => executing)).toBe(response);
  expect((yield* h.result(event(response))).isError).toBe(false);
});

effectTest(
  "bounds exact-identity receipts and revokes turn/replacement/shutdown ownership",
  function* () {
    const h = receiptHost();
    const { receipts } = h;
    let owner = h.owner;
    const response = failed();
    const retain = (id = "call") => receipts.retain(owner, "subagent_send", id, "send", response);
    retain();
    expect(
      (yield* h.result(event({ ...response, details: structuredClone(response.details) }))).isError,
    ).toBe(false);
    expect((yield* h.result(event(response, "subagent_status"))).isError).toBe(false);
    expect((yield* h.result(event(response, "subagent_send", "wrong"))).isError).toBe(false);
    expect((yield* h.result(event(response))).isError).toBe(true);
    retain();
    yield* h.emit("agent_end");
    expect((yield* h.result(event(response))).isError).toBe(false);
    retain();
    owner = receipts.activate();
    expect((yield* h.result(event(response))).isError).toBe(false);
    for (let index = 0; index <= 256; index++) retain(String(index));
    expect((yield* h.result(event(response, "subagent_send", "0"))).isError).toBe(false);
    expect((yield* h.result(event(response, "subagent_send", "1"))).isError).toBe(true);
    expect((yield* h.result(event(response, "subagent_send", "256"))).isError).toBe(true);
    retain("x".repeat(1025));
    expect((yield* h.result(event(response, "subagent_send", "x".repeat(1025)))).isError).toBe(
      false,
    );
    retain();
    receipts.deactivate();
    retain();
    expect((yield* h.result(event(response))).isError).toBe(false);
  },
);
