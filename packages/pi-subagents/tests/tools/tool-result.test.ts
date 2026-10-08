// Actual registered execute results plus Pi's compositional tool_result boundary.
import {
  createEventBus,
  type AgentToolResult,
  type ExtensionHandler,
  type ToolDefinition,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { describe, expect } from "vitest";
import * as Schema from "effect/Schema";
import { effectTest, step } from "../support/effect-test.ts";
import { registerSubagentApplication } from "../../src/application/register.ts";
import { registerSubagentChildBridge } from "../../src/boundary/host-child.ts";
import { registerSubagentErrorReceipts } from "../../src/boundary/host-tool-result.ts";
import type { LocalPiChildIpcHandlers } from "../../src/boundary/local-pi-ipc.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "../../src/run/errors.ts";
import { SubagentService } from "../../src/run/service.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { SubagentBackendRegistry } from "../../src/backend/service.ts";
import {
  makeAwaitDetails,
  makeCompactToolDetails,
  makeStartDetails,
} from "../../src/tools/details.ts";
import { decodeCompactToolDetails } from "../../src/tools/details-schema.ts";
import type { SubagentToolRuntime } from "../../src/tools/execute.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import {
  context,
  executeTool,
  fallbackProfileService,
  testBackendRegistry,
  view,
} from "./fixtures/tool-harness.ts";

type Handler = ExtensionHandler<any, any>;
type HookEvent = Parameters<Handler>[0];
type Tool = ToolDefinition<any, any, any>;
const toolHosts = new WeakMap<Tool, Map<string, Handler[]>>();
const runHooks = (
  hooks: ReadonlyMap<string, Handler[]> | undefined,
  name: string,
  event: HookEvent,
) =>
  Effect.forEach(hooks?.get(name) ?? [], (hook) => step(() => Promise.resolve(hook(event, ctx))));
const execute = (
  tool: Tool,
  args: Parameters<Tool["execute"]>[1],
  options?: Parameters<typeof executeTool>[2],
) =>
  Effect.gen(function* () {
    // Owned host fixture follows Pi start and admission provenance before execution.
    const hooks = toolHosts.get(tool);
    const call = { toolName: tool.name, toolCallId: options?.callID ?? "call" };
    yield* runHooks(hooks, "tool_execution_start", { type: "tool_execution_start", ...call, args });
    const admission = { type: "tool_call", ...call, input: args } as const;
    // Like Pi, admission stops at the first blocking hook.
    for (const hook of hooks?.get("tool_call") ?? []) {
      const result = yield* step(() => Promise.resolve(hook(admission, ctx)));
      if (result?.block) return yield* Effect.die(new Error(result.reason));
    }
    return yield* step(() => executeTool(tool, args, options));
  });
const serializeResult = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
  } = recordingExtensionHost(
    {},
    {
      events: createEventBus(),
      registerFlag: () => undefined,
      registerProvider: () => undefined,
      getFlag: (name: string) => (name === "pi-subagents-supervisor-config" ? "/unused" : false),
    },
  );
  const emit = (name: string) => runHooks(hooks, name, {}).pipe(Effect.asVoid);
  const result = (event: ToolResultEvent) =>
    Effect.gen(function* () {
      let current = event;
      for (const handler of hooks.get("tool_result") ?? []) {
        const patch = yield* step(() => Promise.resolve(handler(current, ctx)));
        if (patch) current = { ...current, ...patch };
      }
      return current;
    });
  /** The one registered receipt hook for `name`; a missing hook fails the test. */
  const dispatch = (name: string, event: HookEvent) =>
    step(() => Promise.resolve(hooks.get(name)![0]!(event, ctx)));
  /** Pi's start event; `parentToolCallId` is present only when supplied. */
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
  /** Pi's admission event; `parentToolCallId` is present only when supplied. */
  const admitCall = (
    toolCallId: string,
    extra: { readonly input?: object; readonly parentToolCallId?: string } = {},
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

/** A host with active error receipts; `earlierResult` is tool_result middleware installed first. */
function receiptHost(earlierResult?: Handler) {
  const h = host();
  if (earlierResult) h.pi.on("tool_result", earlierResult);
  const receipts = registerSubagentErrorReceipts(h.pi);
  return { ...h, receipts, owner: receipts.activate() };
}

/** Registers proxied coordinator tools whose every call resolves through `proxyCall`. */
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
const pendingFailure = () => ({
  id: "pending",
  code: "steer_outcome_uncertain",
  message: "Guidance may have been sent; acknowledgement is pending. Do not resend.",
  pendingDelivery: true as const,
});
/** Backend steering failures exactly as the send producer receives them. */
const steeringError = (pendingDelivery: boolean, code = "steer_outcome_uncertain") =>
  new SubagentProcessError({
    operation: "steer",
    code,
    message: "Guidance may have been sent; acknowledgement is pending. Do not resend.",
    ...(pendingDelivery && { pendingDelivery: true }),
  });
const failed = () => ({
  content: [{ type: "text" as const, text: "exact failure and no-resend evidence" }],
  details: makeCompactToolDetails({ action: "send", runs: [], actionFailures: [failure()] }),
});

function ownedTools(service = subagentServiceDouble({}), earlierResult?: Handler) {
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
  // The overflow start was not retained. A freed slot must not turn its lost empty
  // parent into model privilege when admission finally arrives.
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
    yield* admitCall("opaque"); // Pi's admission hook drops the empty parent ID.
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
  "ignores oversized and foreign starts without stealing owned-call capacity",
  function* () {
    const { receipts, owner, startCall, admitCall } = receiptHost();
    yield* startCall("inactive");
    receipts.deactivate();
    yield* startCall("while-inactive");
    const activeOwner = receipts.activate();
    yield* startCall("foreign", { toolName: "read" });
    yield* startCall("x".repeat(1_025));
    for (let i = 0; i < 256; i++) yield* startCall(`owned-${i}`);
    expect(yield* admitCall("owned-255")).toBeUndefined();
    expect(receipts.isNested(activeOwner, "owned-255")).toBe(false);
    expect(receipts.isNested(owner, "owned-255")).toBe(true);
  },
);

effectTest(
  "composes with prior content, images and error middleware without replacing details",
  function* () {
    const content: AgentToolResult<unknown>["content"] = [
      { type: "text", text: "earlier content middleware" },
      { type: "image", mimeType: "image/png", data: "YQ==" },
    ];
    const h = ownedTools(
      subagentServiceDouble({
        send: (id) =>
          id === "good"
            ? Effect.succeed(view({ id }))
            : Effect.fail(new InvalidSubagentRequestError(failure())),
      }),
      () => ({ content, isError: true }),
    );
    for (const id of ["uncertain", "good"]) {
      const response = yield* execute(h.tools.get("subagent_send")!, {
        runIds: [id],
        message: "guidance",
      });
      const result = yield* h.result(event(response));
      expect(result.isError).toBe(true);
      expect(result.content).toBe(content);
      expect(result.details).toBe(response.details);
    }
  },
);

effectTest(
  "marks all-failed and mixed registered executions without losing evidence or content middleware",
  function* () {
    const h = ownedTools(
      subagentServiceDouble({
        send: (id) =>
          id === "good"
            ? Effect.succeed(view({ id }))
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
      expect(yield* h.result(original)).toEqual(original); // one-shot, no replay
    }
  },
);

effectTest(
  "leaves typed pending delivery unflagged while real failures in the same send still mark it",
  function* () {
    const image = { type: "image" as const, mimeType: "image/png", data: "YQ==" };
    const h = ownedTools(
      subagentServiceDouble({
        send: (id) =>
          id === "good"
            ? Effect.succeed(view({ id }))
            : id === "pending" || id === "pending-2"
              ? Effect.fail(steeringError(true))
              : id === "unflagged"
                ? Effect.fail(steeringError(false))
                : id === "wrong-code"
                  ? Effect.fail(steeringError(true, "start_outcome_uncertain"))
                  : Effect.fail(new InvalidSubagentRequestError(failure("not_running", id))),
      }),
    );
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, boolean]> = [
      [["pending"], false],
      [["pending", "pending-2"], false],
      [["good", "pending"], false],
      [["pending", "bad"], true],
      [["pending", "unflagged"], true],
      [["unflagged"], true],
      [["wrong-code"], true],
    ];
    for (const [ids, isError] of cases) {
      const response = yield* execute(h.tools.get("subagent_send")!, {
        runIds: ids,
        message: "guidance",
      });
      const flagged = ids.filter((id) => id.startsWith("pending"));
      expect(response.details).toMatchObject({
        action: "send",
        runCount: ids.filter((id) => id === "good").length,
      });
      const decoded = decodeCompactToolDetails(response.details);
      const failures = decoded && decoded.action !== "models" ? (decoded.actionFailures ?? []) : [];
      expect(failures.filter((entry) => entry.pendingDelivery === true)).toHaveLength(
        flagged.length,
      );
      // Content middleware may add native images; receipts never replace content or details.
      const content = [...response.content, image];
      const patched = yield* h.result(event({ ...response, content }));
      expect(patched.isError).toBe(isError);
      expect(patched.content).toBe(content);
      expect(patched.details).toBe(response.details);
    }
  },
);

effectTest(
  "classifies structurally decoded pending flags by action and code before marking receipts",
  function* () {
    const { receipts, owner, result } = receiptHost();
    const base = makeCompactToolDetails({ action: "send", runs: [], actionFailures: [failure()] });
    for (const [tool, action, entry, isError] of [
      ["subagent_send", "send", pendingFailure(), false],
      ["subagent_send", "send", { ...pendingFailure(), code: "not_running" }, true],
      ["subagent_send", "send", { ...pendingFailure(), code: "send_outcome_uncertain" }, true],
      ["subagent_reply", "reply", pendingFailure(), true],
      ["subagent_lifecycle", "stop", pendingFailure(), true],
    ] as const) {
      const details = { ...base, action, actionFailures: [entry] };
      receipts.retain(owner, tool, "call", action, details);
      const patched = yield* result(event({ content: [], details }, tool));
      expect(patched.isError).toBe(isError);
      expect(patched.details).toBe(details);
    }
  },
);

effectTest(
  "does not mark successful status/list/await observations of failed workers or cancelled waits",
  function* () {
    const h = receiptHost();
    const run = view({ id: "failed", state: "failed", error: "worker failure" });
    for (const action of ["status", "list", "await"] as const) {
      for (const cancelled of [false, true]) {
        const response = {
          content: [],
          details:
            action === "await"
              ? makeAwaitDetails({ runs: [run], awaitUntil: "all_finished", cancelled })
              : makeCompactToolDetails({ action, runs: [run] }),
        };
        proxiedTools(h, () => Promise.resolve(response));
        const tool = `subagent_${action}` as const;
        const result = yield* execute(h.tools.get(tool)!, {
          runIds: [run.id],
          until: "all_finished",
        });
        expect((yield* h.result(event(result, tool))).isError).toBe(false);
      }
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
    const retain = (id = "call") =>
      receipts.retain(owner, "subagent_send", id, "send", response.details);
    retain();
    expect(
      (yield* h.result(event({ ...response, details: structuredClone(response.details) }))).isError,
    ).toBe(false);
    expect((yield* h.result(event(response, "subagent_reply"))).isError).toBe(false);
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

effectTest(
  "declines malformed, mismatched and unbounded details rather than labelling foreign failures",
  function* () {
    const { receipts, owner, result } = receiptHost();
    for (const details of [
      { actionFailures: [failure()] },
      { ...failed().details, action: "reply" },
      { ...failed().details, foreign: "x".repeat(48_001) },
    ]) {
      receipts.retain(owner, "subagent_send", "call", "send", details);
      expect((yield* result(event({ content: [], details }))).isError).toBe(false);
    }
  },
);

effectTest(
  "installs root hooks once and revokes results immediately on replacement and shutdown",
  function* () {
    const h = host();
    registerSubagentApplication(h.pi, {
      loadSettings: () => Promise.resolve(),
      getAgentDirectory: () => "/tmp/pi-subagents-tool-results-tests",
    });
    try {
      yield* h.emit("session_start");
      const tool = h.tools.get("subagent_status")!;
      const response = yield* execute(tool, { runIds: ["missing"] }, { context: ctx });
      expect((yield* h.result(event(response, tool.name))).isError).toBe(true);
      const old = yield* execute(tool, { runIds: ["missing"] }, { context: ctx });
      yield* h.emit("session_tree");
      expect(h.hooks.get("tool_result")).toHaveLength(1);
      expect((yield* h.result(event(old, tool.name))).isError).toBe(false);
      const current = yield* execute(
        h.tools.get("subagent_status")!,
        { runIds: ["missing"] },
        { context: ctx },
      );
      yield* h.emit("session_shutdown");
      expect((yield* h.result(event(current, tool.name))).isError).toBe(false);
    } finally {
      yield* h.emit("session_shutdown");
    }
  },
);

describe("local Pi serialized proxy", () => {
  effectTest(
    "marks decoded final failures, not the source identity, and revokes shutdown receipts",
    function* () {
      const h = host();
      let response: AgentToolResult<unknown> = failed();
      let listener: LocalPiChildIpcHandlers | undefined;
      registerSubagentChildBridge(h.pi, {
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
              if (contact.type === "proxy_request")
                listener!.onControl({
                  channel: "pi-subagents",
                  type: "proxy_response",
                  requestId: contact.requestId,
                  ok: true,
                  payloadJson: serializeResult(response),
                });
            }),
        }),
      });
      try {
        yield* h.emit("session_start");
        const tool = h.tools.get("subagent_send")!;
        for (const [confirmed, failures] of [
          [0, [failure()]],
          [0, [failure("not_running")]],
          [0, []],
          [0, [pendingFailure()]],
          [1, [pendingFailure()]],
          [0, [pendingFailure(), failure("not_running", "definite")]],
          [0, [pendingFailure(), failure("steer_outcome_uncertain", "unflagged")]],
        ] as const) {
          response = {
            content: [{ type: "text", text: "exact proxy evidence" }],
            details: makeCompactToolDetails({
              action: "send",
              runs: confirmed ? [view({ id: "confirmed" })] : [],
              actionFailures: failures,
            }),
          };
          const decoded = yield* execute(
            tool,
            { runIds: ["uncertain"], message: "once" },
            { context },
          );
          expect(decoded).toEqual(response);
          expect(decoded.details).not.toBe(response.details);
          expect((yield* h.result(event(response))).isError).toBe(false);
          const patched = yield* h.result(event(decoded));
          // Typed pending delivery survives the private wire without becoming a tool error.
          expect(patched.isError).toBe(failures.some((entry) => !("pendingDelivery" in entry)));
          expect(patched.details).toBe(decoded.details);
          expect(patched.content).toBe(decoded.content);
        }
        response = failed();
        const decoded = yield* execute(tool, { runIds: ["uncertain"], message: "once" });
        yield* h.emit("session_shutdown");
        expect((yield* h.result(event(decoded))).isError).toBe(false);
        expect(h.hooks.get("tool_result")).toHaveLength(1);
      } finally {
        yield* h.emit("session_shutdown");
      }
    },
  );
});

effectTest("marks failed start receipts without changing the proxy wire format", function* () {
  const h = receiptHost();
  const response = {
    content: [{ type: "text" as const, text: "startup outcome is uncertain; do not retry" }],
    details: makeStartDetails({
      startEntries: [
        {
          index: 0,
          name: "worker",
          profile: "worker",
          status: "failed",
          routeStatus: "unavailable",
        },
      ],
      startFailures: [{ index: 0, message: "startup uncertain", code: "start_outcome_uncertain" }],
    }),
  };
  proxiedTools(h, () => Promise.resolve(response));
  const actual = yield* execute(h.tools.get("subagent_start")!, { agents: [{ task: "task" }] });
  expect(actual).toBe(response);
  expect((yield* h.result(event(actual, "subagent_start"))).isError).toBe(true);
});
