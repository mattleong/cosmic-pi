import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { Type } from "typebox";
import {
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  loadCodePreviewSettings,
  withCodePreviewShell,
  type CompactAnimationScheduler,
  type CodePreviewSettings,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  invokeBestEffort,
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  safeTextPrefix,
} from "pi-cosmic-core";
import { registerSubagentMessageRenderers } from "../application/messages.ts";
import type { LocalPiContact, LocalPiParentControl } from "../backend/local-pi-protocol.ts";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { PARENT_REPLY_PREFIX } from "../supervisor/protocol.ts";
import { clipUtf8Text } from "../run/state.ts";
import { NESTED_SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import { encodeFleetActionRequest, fleetSnapshotProxyRequest } from "../tools/proxy-fleet.ts";
import { registerSubagentProxyManagerCommand } from "../settings/proxy-controller.ts";
import { decodeSubagentProxyResult, encodeSubagentProxyInput } from "../tools/proxy-protocol.ts";
import { decodeSubagentContract, isSubagentContractTool } from "../tools/contract-schema.ts";
import type { SubagentToolInput } from "../tools/schema.ts";
import { observeAwaitInterruption } from "../tools/execute-await.ts";
import type { SubagentProxyRequest } from "../tools/proxy-protocol.ts";
import { publishChildQuestionnaireRelay } from "./host-ask-user.ts";
import {
  CONTACT_PARENT_LABEL,
  contactParentCompactSummary,
  contactParentExpandedContent,
  contactParentRenderers,
} from "../tools/render-parent.ts";
import { registerSubagentTools } from "../tools/subagent.ts";
import { registerSubagentErrorReceipts } from "./host-tool-result.ts";
import { consumeRuntimeApiCredentials, registerChildPiFastModeHook } from "./host-child-pi.ts";
import { parentCorrelations, parentContactRejection } from "./host-child-correlation.ts";
import { isSubagentChildProcess, subagentChildRunId } from "./host-environment.ts";
import { nodeWriteSync } from "./node-builtins.ts";
import { protocolMismatch } from "./protocol-fingerprint.ts";
import {
  openLocalPiChildIpc,
  ParentContactError,
  type LocalPiChildIpcChannel,
} from "./local-pi-ipc.ts";

const QUESTION_TIMEOUT_MILLIS = 10 * 60_000;
const MAX_TOOL_REPLY_BYTES = MAX_TOOL_OUTPUT_CHARS - PARENT_REPLY_PREFIX.length;
const CHILD_PROXY_TOOL_NAMES = [...NESTED_SUBAGENT_TOOL_NAMES, "contact_parent"];
const CHILD_PRIVATE_TOOL_NAME_SET: ReadonlySet<string> = new Set(CHILD_PROXY_TOOL_NAMES);
let nextRequest = 1;

const clipToolReply = (value: string): string => clipUtf8Text(value, MAX_TOOL_REPLY_BYTES);

const decodeProxyFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ message: Schema.String.check(Schema.isMaxLength(MAX_TOOL_OUTPUT_CHARS)) }),
  ),
);

const proxyFailure = (source: string): ParentContactError => {
  const decoded = decodeProxyFailure(source);
  return new ParentContactError({
    message: Option.isSome(decoded)
      ? clipToolReply(decoded.value.message)
      : "The root subagent coordinator rejected the call.",
  });
};

const ContactParentParameters = Type.Object(
  {
    kind: StringEnum(["progress", "question", "warning"] as const),
    message: Type.String({
      minLength: 1,
      maxLength: MAX_PARENT_MESSAGE_CHARS,
      pattern: ".*\\S.*",
    }),
  },
  { additionalProperties: false },
);

export interface SubagentChildBridgeBoundaries {
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
  readonly openIpc: () => LocalPiChildIpcChannel;
}

const LIVE_CHILD_BRIDGE_BOUNDARIES: SubagentChildBridgeBoundaries = {
  loadSettings: loadCodePreviewSettings,
  openIpc: openLocalPiChildIpc,
};
const parentContactUnavailable = () => new Error("Parent contact is unavailable for this session.");

interface ChildSessionInput {
  readonly sessionId: string | undefined;
  readonly questionnaires: Set<string>;
  detachRelay?: (() => void) | undefined;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  token: number | undefined;
}

export function registerSubagentChildBridge(
  pi: ExtensionAPI,
  boundaries: SubagentChildBridgeBoundaries = LIVE_CHILD_BRIDGE_BOUNDARIES,
): void {
  registerSubagentMessageRenderers(pi);
  const receipts = registerSubagentErrorReceipts(pi);
  pi.registerFlag("pi-subagents-fast-mode", {
    description: "Private OpenAI fast-mode request for this subagent",
    type: "boolean",
    default: false,
  });
  const runtimeApi = consumeRuntimeApiCredentials(process.env);
  if (runtimeApi.apiKey && runtimeApi.provider)
    pi.registerProvider(runtimeApi.provider, { apiKey: runtimeApi.apiKey });

  const ipc = boundaries.openIpc();
  const pending = parentCorrelations<string>();
  const pendingProxy = parentCorrelations<AgentToolResult<unknown>>();
  let currentSession: ChildSessionInput | undefined;

  const removeProxyNames = (): void =>
    invokeHostCallback(() => {
      const kept = pi.getActiveTools().filter((name) => !CHILD_PRIVATE_TOOL_NAME_SET.has(name));
      pi.setActiveTools(kept);
    }, undefined);

  const rejectPending = (): void => {
    pending.rejectAll("The parent subagent supervisor disconnected.");
    pendingProxy.rejectAll("The root subagent coordinator disconnected.");
  };
  const sendCancel = (type: "proxy_cancel" | "contact_cancel", requestId: string) =>
    ipc.sendContact({ channel: "pi-subagents", type, requestId }).pipe(Effect.ignore);

  const deactivate = (input: ChildSessionInput | undefined): void => {
    receipts.deactivate();
    if (input) {
      input.token = undefined;
      input.detachRelay?.();
      input.detachRelay = undefined;
    }
    if (currentSession === input) currentSession = undefined;
    removeProxyNames();
    rejectPending();
  };
  const isSessionCurrent = (input: ChildSessionInput): boolean => currentSession === input;
  const isActivationCurrent = (input: ChildSessionInput, token: number): boolean =>
    isSessionCurrent(input) && input.token === token && slot.isCurrent(token);
  const forkContact = (input: ChildSessionInput, contact: LocalPiContact): void => {
    if (isSessionCurrent(input)) slot.fork(ipc.sendContact(contact).pipe(Effect.ignore));
  };

  const onControl = (input: ChildSessionInput, message: LocalPiParentControl): void => {
    if (!isSessionCurrent(input)) return;
    if (message.type === "proxy_response") {
      input.questionnaires.delete(message.requestId);
      const result = message.ok ? decodeSubagentProxyResult(message.payloadJson) : undefined;
      pendingProxy.settle(
        message.requestId,
        result
          ? Effect.succeed(result)
          : Effect.fail(message.ok ? proxyFailure("{}") : proxyFailure(message.payloadJson)),
      );
      return;
    }
    if (message.type === "proxy_notification") {
      const ok = invokeHostCallback(() => {
        pi.sendMessage(
          {
            customType: "pi-subagents-proxy-notification",
            content: message.message,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        return true;
      }, false);
      forkContact(input, {
        channel: "pi-subagents",
        type: "proxy_notification_ack",
        requestId: message.requestId,
        ok,
      });
      return;
    }
    if (message.type === "turn_input_barrier") {
      forkContact(input, {
        channel: "pi-subagents",
        type: "turn_input_barrier_ack",
        requestId: message.requestId,
      });
      return;
    }
    if (message.type === "parent_reply") {
      forkContact(input, {
        channel: "pi-subagents",
        type: "parent_reply_ack",
        requestId: message.ackId,
        ok: pending.settle(message.requestId, Effect.succeed(message.message)),
      });
      return;
    }
    if (message.type === "peer_notice")
      invokeBestEffort(() =>
        pi.sendMessage(
          {
            customType: "pi-subagents-peer-notice",
            content: message.message,
            display: true,
          },
          { deliverAs: "nextTurn", triggerTurn: false },
        ),
      );
  };

  const proxyCall = (
    input: ChildSessionInput,
    token: number,
    encoded: SubagentProxyRequest,
    signal: AbortSignal | undefined,
    onInterruption?: () => void,
  ): Promise<AgentToolResult<unknown>> => {
    if (!isActivationCurrent(input, token))
      return Promise.reject(new Error("Subagent proxy is unavailable for this session."));
    const requestId = `proxy-${process.pid}-${nextRequest++}`;
    if (encoded.tool === "ask_user") input.questionnaires.add(requestId);
    return slot
      .run(
        observeAwaitInterruption(
          pendingProxy.await(
            requestId,
            ipc.sendContact({
              channel: "pi-subagents",
              type: "proxy_request",
              requestId,
              tool: encoded.tool,
              argumentsJson: encoded.argumentsJson,
            }),
            () => {
              if (isActivationCurrent(input, token))
                slot.fork(
                  sendCancel("proxy_cancel", requestId).pipe(
                    Effect.ensuring(Effect.sync(() => input.questionnaires.delete(requestId))),
                  ),
                );
            },
          ),
          onInterruption,
        ),
        signal,
      )
      .then((result) => {
        if (!isActivationCurrent(input, token))
          throw new Error("Subagent proxy is unavailable for this session.");
        if (
          result.structuredContent !== undefined &&
          (!isSubagentContractTool(encoded.tool) ||
            decodeSubagentContract(encoded.tool)(result.structuredContent) === undefined)
        )
          throw new Error("Subagent proxy returned a mismatched orchestration result.");
        return result;
      });
  };

  const registerContactParent = (
    input: ChildSessionInput,
    token: number,
    scheduleAnimation: CompactAnimationScheduler,
  ): void => {
    pi.registerTool(
      withCodePreviewShell(
        {
          ...contactParentRenderers,
          name: "contact_parent",
          label: CONTACT_PARENT_LABEL,
          description:
            "Send progress, record a non-blocking warning in parent-visible run status, or ask a blocking parent question. Repeat warnings in the final report; use a question instead when a risk could invalidate work the parent is doing now.",
          parameters: ContactParentParameters,
          executionMode: "sequential",
          execute(_toolCallId, params, signal) {
            if (!isActivationCurrent(input, token))
              return Promise.reject(parentContactUnavailable());
            const requestId = `contact-${process.pid}-${nextRequest++}`;
            const send = ipc.sendContact({
              channel: "pi-subagents",
              type: "contact_parent",
              requestId,
              kind: params.kind,
              message: safeTextPrefix(params.message, MAX_PARENT_MESSAGE_CHARS),
            });
            const question = params.kind === "question";
            const delivery = question
              ? pending
                  .await(
                    requestId,
                    send,
                    () => {
                      if (isActivationCurrent(input, token))
                        slot.fork(sendCancel("contact_cancel", requestId));
                    },
                    false,
                  )
                  .pipe(
                    Effect.timeoutOrElse({
                      duration: QUESTION_TIMEOUT_MILLIS,
                      orElse: () =>
                        Effect.fail(
                          new ParentContactError({
                            message: "Parent question timed out without a reply.",
                          }),
                        ),
                    }),
                    Effect.map((reply) => `${PARENT_REPLY_PREFIX}${clipToolReply(reply)}`),
                  )
              : send.pipe(Effect.as(`Parent received ${params.kind}.`));
            return slot.run(delivery, signal).then(
              (text) => {
                if (!isActivationCurrent(input, token)) throw parentContactUnavailable();
                return { content: [{ type: "text" as const, text }], details: {} };
              },
              question
                ? (cause: unknown) => {
                    if (signal?.aborted) throw new Error("Parent question was cancelled.");
                    throw parentContactRejection(cause);
                  }
                : undefined,
            );
          },
        },
        {
          scheduleAnimation,
          compactSummary: contactParentCompactSummary,
          expandedContent: contactParentExpandedContent,
        },
      ),
    );
  };

  const slot = makePiSessionRuntimeSlot<
    ChildSessionInput,
    CodePreviewSchedulerService,
    never,
    never,
    CodePreviewSchedulerServiceContract
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.sync(() =>
              ipc.listen({
                onControl: (message) => onControl(input, message),
                onDisconnect: () => {
                  if (isSessionCurrent(input)) rejectPending();
                },
              }),
            ),
            (detach) =>
              Effect.forEach(
                [...input.questionnaires],
                (requestId) => sendCancel("proxy_cancel", requestId),
                { discard: true },
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    input.questionnaires.clear();
                    detach();
                    rejectPending();
                  }),
                ),
              ),
          ).pipe(Effect.asVoid),
        ).pipe(Layer.merge(CodePreviewSchedulerService.layer)),
      ),
    startup: (input) =>
      bestEffortHostBootstrap("pi-subagents.child-preview-settings", (signal) =>
        boundaries.loadSettings(input.cwd, input.projectTrusted, signal),
      ).pipe(Effect.andThen(CodePreviewSchedulerService)),
    onActivated: (input, token, scheduler) => {
      if (!isSessionCurrent(input) || !slot.isCurrent(token)) return;
      input.token = token;
      const call = (
        toolInput: SubagentToolInput,
        signal?: AbortSignal,
        onInterruption?: () => void,
      ) => proxyCall(input, token, encodeSubagentProxyInput(toolInput), signal, onInterruption);
      const scheduleAnimation: CompactAnimationScheduler = (interval, tick) =>
        isActivationCurrent(input, token) ? scheduler.schedule(interval, tick) : undefined;
      try {
        if (input.sessionId)
          input.detachRelay = publishChildQuestionnaireRelay(
            pi.events,
            input.sessionId,
            () => isActivationCurrent(input, token),
            (request, signal) => proxyCall(input, token, request, signal),
          );
        registerSubagentTools(
          pi,
          {
            scheduleAnimation,
            environment: { cwd: input.cwd, projectTrusted: input.projectTrusted },
            proxyCall: call,
            run: () => Promise.reject(new Error("Nested Pi uses the root coordinator proxy.")),
          },
          { receipts, owner: receipts.activate() },
        );
        registerContactParent(input, token, scheduleAnimation);
        const runId = subagentChildRunId();
        if (runId)
          registerSubagentProxyManagerCommand(
            pi,
            runId,
            (request, expected, signal) =>
              proxyCall(input, token, encodeFleetActionRequest(request, expected), signal),
            (signal) => proxyCall(input, token, fleetSnapshotProxyRequest, signal),
            () => isActivationCurrent(input, token),
          );
        if (!isActivationCurrent(input, token)) throw new Error("Stale child activation.");
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...CHILD_PROXY_TOOL_NAMES])]);
      } catch {
        deactivate(input);
        if (slot.isCurrent(token)) slot.shutdown().catch(() => undefined);
      }
    },
    onDeactivated: deactivate,
    onStartFailure: deactivate,
  });

  registerChildPiFastModeHook(pi, () => pi.getFlag("pi-subagents-fast-mode") === true);

  pi.on("session_start", (_event, ctx) => {
    deactivate(currentSession);
    const captured = captureSessionHost(ctx);
    if (!Predicate.isTagged(captured, "Captured")) return slot.shutdown();
    const sessionId = invokeHostCallback(() => ctx.sessionManager.getSessionId(), undefined);
    const input: ChildSessionInput = {
      sessionId,
      questionnaires: new Set(),
      cwd: captured.cwd,
      projectTrusted: isProjectTrusted(ctx),
      token: undefined,
    };
    currentSession = input;
    return slot.start(input, captured.signal).then(() => undefined);
  });

  pi.on("session_shutdown", () => {
    deactivate(currentSession);
    return slot.shutdown();
  });
}

export default function subagentChildBridge(pi: ExtensionAPI): void {
  if (!isSubagentChildProcess()) return;
  const mismatch = protocolMismatch(process.env);
  if (mismatch) {
    // A dedicated child that can't speak its parent's protocol stops before taking any work; the
    // parent reports this stderr line as the failed start.
    nodeWriteSync(2, `${mismatch}\n`);
    process.exit(78);
  }
  registerSubagentChildBridge(pi);
}
