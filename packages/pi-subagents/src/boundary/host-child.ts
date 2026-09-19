// The child-only Pi/Node bridge is intentionally Promise- and callback-shaped.
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import type { LocalPiContact, LocalPiParentControl } from "../backend/local-pi-protocol.ts";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { clipUtf8Text, safeTextPrefix } from "../run/state.ts";
import { SUBAGENT_TOOL_NAMES } from "../run/tool-policy.ts";
import { registerSubagentProxyManagerCommand } from "../settings/proxy-controller.ts";
import { decodeSubagentProxyResult, encodeSubagentProxyInput } from "../tools/proxy-protocol.ts";
import type { SubagentToolInput } from "../tools/schema.ts";
import { observeAwaitInterruption } from "../tools/execute-await.ts";
import type { SubagentProxyRequest } from "../tools/proxy-protocol.ts";
import { publishChildQuestionnaireRelay } from "./host-ask-user.ts";
import {
  createParentCompactSummary,
  createParentExpandedContent,
} from "../tools/compact-parent-summary.ts";
import { registerSubagentTools } from "../tools/subagent.ts";
import { consumeRuntimeApiCredentials, registerChildPiFastModeHook } from "./host-child-pi.ts";
import { isSubagentChildProcess, subagentChildRunId } from "./host-environment.ts";
import {
  openLocalPiChildIpc,
  ParentContactError,
  type LocalPiChildIpcChannel,
} from "./local-pi-ipc.ts";

const PARENT_REPLY_PREFIX = "Parent replied: ";
const QUESTION_TIMEOUT_MILLIS = 10 * 60_000;
const MAX_TOOL_REPLY_BYTES = MAX_TOOL_OUTPUT_CHARS - PARENT_REPLY_PREFIX.length;
const CHILD_PROXY_TOOL_NAMES = [...SUBAGENT_TOOL_NAMES, "contact_parent"];
const CHILD_PROXY_TOOL_NAME_SET: ReadonlySet<string> = new Set(CHILD_PROXY_TOOL_NAMES);
let nextRequest = 1;

const clipToolReply = (value: string): string => clipUtf8Text(value, MAX_TOOL_REPLY_BYTES);

const ProxyFailureSchema = Schema.Struct({
  message: Schema.String.check(Schema.isMaxLength(MAX_TOOL_OUTPUT_CHARS)),
});

const proxyFailure = (source: string): ParentContactError => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(ProxyFailureSchema))(source);
  return new ParentContactError({
    message: Option.isSome(decoded)
      ? clipToolReply(decoded.value.message)
      : "The root subagent coordinator rejected the call.",
  });
};

type ContactParentEnvelope = Extract<LocalPiContact, { readonly type: "contact_parent" }>;

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
  pi.registerFlag("pi-subagents-fast-mode", {
    description: "Private OpenAI fast-mode request for this subagent",
    type: "boolean",
    default: false,
  });
  const openaiFastMode = pi.getFlag("pi-subagents-fast-mode") === true;
  const runtimeApi = consumeRuntimeApiCredentials(process.env);
  if (runtimeApi.apiKey && runtimeApi.provider)
    pi.registerProvider(runtimeApi.provider, { apiKey: runtimeApi.apiKey });

  const ipc = boundaries.openIpc();
  type Correlations<A> = Map<string, Deferred.Deferred<A, ParentContactError>>;
  const pending: Correlations<string> = new Map();
  const pendingProxy: Correlations<AgentToolResult<unknown>> = new Map();
  let currentSession: ChildSessionInput | undefined;

  const removeProxyNames = (): void => {
    try {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !CHILD_PROXY_TOOL_NAME_SET.has(name)));
    } catch {
      // A stale host cannot turn lifecycle cleanup into an unhandled callback error.
    }
  };

  const rejectAll = <A>(waiters: Correlations<A>, message: string): void => {
    for (const waiter of waiters.values())
      Deferred.doneUnsafe(waiter, Effect.fail(new ParentContactError({ message })));
    waiters.clear();
  };
  const rejectPending = (): void => {
    rejectAll(pending, "The parent subagent supervisor disconnected.");
    rejectAll(pendingProxy, "The root subagent coordinator disconnected.");
  };
  const deleteExact = <A>(
    waiters: Correlations<A>,
    requestId: string,
    waiter: Deferred.Deferred<A, ParentContactError>,
  ): boolean => {
    if (waiters.get(requestId) !== waiter) return false;
    waiters.delete(requestId);
    return true;
  };
  const correlate = <A>(
    waiters: Correlations<A>,
    requestId: string,
    send: Effect.Effect<void, ParentContactError>,
    cancel: () => void,
    cancelDefiniteUnsent = true,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const waiter = Deferred.makeUnsafe<A, ParentContactError>();
        waiters.set(requestId, waiter);
        return waiter;
      }),
      (waiter) =>
        send.pipe(
          Effect.catch((error) =>
            !cancelDefiniteUnsent && error.code === "transport_not_sent"
              ? Effect.sync(() => deleteExact(waiters, requestId, waiter)).pipe(
                  Effect.andThen(Effect.fail(error)),
                )
              : Effect.fail(error),
          ),
          Effect.andThen(Deferred.await(waiter)),
        ),
      (waiter, exit) =>
        Effect.sync(() => {
          if (deleteExact(waiters, requestId, waiter) && Exit.isFailure(exit)) cancel();
        }),
    );

  const deactivate = (input: ChildSessionInput | undefined): void => {
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
  let slot!: ReturnType<
    typeof makePiSessionRuntimeSlot<ChildSessionInput, CodePreviewSchedulerService, never, never>
  >;
  const isActivationCurrent = (input: ChildSessionInput, token: number): boolean =>
    isSessionCurrent(input) && input.token === token && slot.isCurrent(token);
  const forkContact = (input: ChildSessionInput, contact: LocalPiContact): void => {
    if (isSessionCurrent(input)) slot.fork(ipc.sendContact(contact).pipe(Effect.ignore));
  };

  const onControl = (input: ChildSessionInput, message: LocalPiParentControl): void => {
    if (!isSessionCurrent(input)) return;
    if (message.type === "proxy_response") {
      const waiter = pendingProxy.get(message.requestId);
      if (!waiter) return;
      deleteExact(pendingProxy, message.requestId, waiter);
      const result = message.ok ? decodeSubagentProxyResult(message.payloadJson) : undefined;
      Deferred.doneUnsafe(
        waiter,
        result
          ? Effect.succeed(result)
          : Effect.fail(message.ok ? proxyFailure("{}") : proxyFailure(message.payloadJson)),
      );
      return;
    }
    if (message.type === "proxy_notification") {
      let ok = true;
      try {
        pi.sendMessage(
          {
            customType: "pi-subagents-proxy-notification",
            content: message.message,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
      } catch {
        ok = false;
      }
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
      const waiter = pending.get(message.requestId);
      if (waiter) {
        deleteExact(pending, message.requestId, waiter);
        Deferred.doneUnsafe(waiter, Effect.succeed(message.message));
      }
      forkContact(input, {
        channel: "pi-subagents",
        type: "parent_reply_ack",
        requestId: message.ackId,
        ok: waiter !== undefined,
      });
      return;
    }
    if (message.type === "peer_notice") {
      try {
        // Do not steer the active child; that can repeat its final response.
        pi.sendMessage(
          {
            customType: "pi-subagents-peer-notice",
            content: message.message,
            display: true,
          },
          { deliverAs: "nextTurn", triggerTurn: false },
        );
      } catch {
        // The child may already be shutting down.
      }
    }
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
          correlate(
            pendingProxy,
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
                  ipc
                    .sendContact({ channel: "pi-subagents", type: "proxy_cancel", requestId })
                    .pipe(
                      Effect.ignore,
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
        input.questionnaires.delete(requestId);
        if (!isActivationCurrent(input, token))
          throw new Error("Subagent proxy is unavailable for this session.");
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
          name: "contact_parent",
          label: "Contact Parent",
          description:
            "Send progress, record a non-blocking warning in parent-visible run status, or ask a blocking parent question. Repeat warnings in the final report; use a question instead when a risk could invalidate work the parent is doing now.",
          parameters: ContactParentParameters,
          executionMode: "sequential",
          execute(_toolCallId, params, signal) {
            if (!isActivationCurrent(input, token))
              return Promise.reject(new Error("Parent contact is unavailable for this session."));
            const requestId = `contact-${process.pid}-${nextRequest++}`;
            const envelope: ContactParentEnvelope = {
              channel: "pi-subagents",
              type: "contact_parent",
              requestId,
              kind: params.kind,
              message: safeTextPrefix(params.message, MAX_PARENT_MESSAGE_CHARS),
            };
            if (params.kind !== "question")
              return slot.run(ipc.sendContact(envelope), signal).then(() => {
                if (!isActivationCurrent(input, token))
                  throw new Error("Parent contact is unavailable for this session.");
                return {
                  content: [{ type: "text" as const, text: `Parent received ${params.kind}.` }],
                  details: {},
                };
              });

            return slot
              .run(
                correlate(
                  pending,
                  requestId,
                  ipc.sendContact(envelope),
                  () => {
                    if (isActivationCurrent(input, token))
                      slot.fork(
                        ipc
                          .sendContact({
                            channel: "pi-subagents",
                            type: "contact_cancel",
                            requestId,
                          })
                          .pipe(Effect.ignore),
                      );
                  },
                  false,
                ).pipe(
                  Effect.timeoutOrElse({
                    duration: QUESTION_TIMEOUT_MILLIS,
                    orElse: () =>
                      Effect.fail(
                        new ParentContactError({
                          message: "Parent question timed out without a reply.",
                        }),
                      ),
                  }),
                ),
                signal,
              )
              .then(
                (reply) => {
                  if (!isActivationCurrent(input, token))
                    throw new Error("Parent contact is unavailable for this session.");
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `${PARENT_REPLY_PREFIX}${clipToolReply(reply)}`,
                      },
                    ],
                    details: {},
                  };
                },
                (error) => {
                  if (signal?.aborted) throw new Error("Parent question was cancelled.");
                  throw error instanceof ParentContactError ? new Error(error.message) : error;
                },
              );
          },
        },
        {
          scheduleAnimation,
          compactSummary: createParentCompactSummary("contact_parent"),
          expandedContent: createParentExpandedContent("contact_parent"),
        },
      ),
    );
  };

  slot = makePiSessionRuntimeSlot<
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
              Effect.suspend(() =>
                Effect.forEach(
                  [...input.questionnaires],
                  (requestId) =>
                    ipc
                      .sendContact({ channel: "pi-subagents", type: "proxy_cancel", requestId })
                      .pipe(Effect.ignore),
                  { discard: true },
                ),
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
      try {
        if (input.sessionId)
          input.detachRelay = publishChildQuestionnaireRelay(
            pi.events,
            input.sessionId,
            () => isActivationCurrent(input, token),
            (request, signal) => proxyCall(input, token, request, signal),
          );
        registerSubagentTools(pi, {
          scheduleAnimation: (interval, tick) =>
            isActivationCurrent(input, token) ? scheduler.schedule(interval, tick) : undefined,
          environment: { cwd: input.cwd, projectTrusted: input.projectTrusted },
          proxyCall: (toolInput, signal, _onUpdate, _ctx, onInterruption) =>
            call(toolInput, signal, onInterruption),
          run: () => Promise.reject(new Error("Nested Pi uses the root coordinator proxy.")),
        });
        registerContactParent(input, token, (interval, tick) =>
          isActivationCurrent(input, token) ? scheduler.schedule(interval, tick) : undefined,
        );
        const runId = subagentChildRunId();
        if (runId) registerSubagentProxyManagerCommand(pi, runId, call);
        if (!isActivationCurrent(input, token)) throw new Error("Stale child activation.");
        pi.setActiveTools([...new Set([...pi.getActiveTools(), ...CHILD_PROXY_TOOL_NAMES])]);
      } catch {
        deactivate(input);
        if (slot.isCurrent(token)) void slot.shutdown();
      }
    },
    onDeactivated: deactivate,
    onStartFailure: deactivate,
  });

  registerChildPiFastModeHook(pi, openaiFastMode);

  pi.on("session_start", (_event, ctx) => {
    deactivate(currentSession);
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return slot.shutdown();
    let sessionId: string | undefined;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      /* Questionnaire discovery fails closed without a stable session. */
    }
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
  registerSubagentChildBridge(pi);
}
