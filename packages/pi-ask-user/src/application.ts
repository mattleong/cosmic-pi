import * as Effect from "effect/Effect";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadCodePreviewSettings,
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CompactAnimationScheduler,
  type CodePreviewSettings,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import {
  acceptsAsyncMessage,
  captureHistoricalDeliveries,
  createQuestionnaireGeneration,
  makeAsyncDelivery,
} from "./boundary/host-delivery.ts";
import {
  makeQuestionnaireActivity,
  type QuestionnaireActivityBridge,
} from "./boundary/host-activity.ts";
import {
  registerOwnedFormCapability,
  registerQuestionnaireCapability,
} from "./boundary/host-owned-calls.ts";
import { askAtQuestionnaireBoundary, requiresQuestionnaireRelay } from "./boundary/host-relay.ts";
import { registerAsyncAskUserTools } from "./tools/ask-user-async.ts";
import { makeAskUserPromptGate } from "./boundary/host-prompt.ts";
import { asyncBusy } from "./questionnaire/async-service.ts";
import { makeAskUserDialogBridge } from "./boundary/host-ui.ts";
import { makeAskUserLayer, type AskUserApplication, type AskUserRuntimeError } from "./layer.ts";
import { AskUserRuntimeClosedError } from "./questionnaire/errors.ts";
import { AskUserService } from "./questionnaire/service.ts";
import { registerAskUserTool } from "./tools/ask-user.ts";

interface AskUserSessionInput {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly generation: string;
  active: boolean;
  activity?: QuestionnaireActivityBridge;
  revokeCapability?: () => void;
  revokeForms?: () => void;
}

type PreviewSettingsLoader = (
  projectCwd: string,
  projectTrusted: boolean,
  signal?: AbortSignal,
) => PromiseLike<CodePreviewSettings | void>;

/** Internal seam for lifecycle and startup-order tests. */
export function askUserWithDependencies(
  pi: ExtensionAPI,
  loadPreviewSettings: PreviewSettingsLoader = loadCodePreviewSettings,
): void {
  const bridge = makeAskUserDialogBridge();
  const promptGate = makeAskUserPromptGate();
  pi.on("ui_prompt_start", () => {
    promptGate.started();
  });
  pi.on("ui_prompt_end", () => {
    promptGate.ended();
  });
  let currentGeneration: string | undefined;
  let historicalDeliveries: ReadonlySet<string> = new Set();

  const slot = makePiSessionRuntimeSlot<
    AskUserSessionInput,
    AskUserApplication,
    never,
    AskUserRuntimeError,
    CodePreviewSchedulerServiceContract
  >({
    makeRuntime: (input) => {
      input.activity = makeQuestionnaireActivity({
        bridge,
        isCurrent: () => input.active,
        run: (effect, signal) =>
          input.active
            ? slot.run(effect, signal)
            : Promise.reject(new Error("Questionnaire session was replaced.")),
      });
      return makePiManagedRuntime(
        pi,
        makeAskUserLayer(
          input.ctx,
          bridge,
          makeAsyncDelivery(pi, input.generation, () => input.active),
          input.generation,
          promptGate,
          input.activity.observer,
        ),
        {
          agentDirectory: getAgentDir,
          packageName: "pi-ask-user",
        },
      );
    },
    startup: ({ cwd, projectTrusted }) =>
      bestEffortHostBootstrap("pi-ask-user.preview-settings", (signal) =>
        loadPreviewSettings(cwd, projectTrusted, signal),
      ).pipe(Effect.andThen(CodePreviewSchedulerService)),
    onActivated: (input, token, scheduler) => {
      const scheduleAnimation: CompactAnimationScheduler = (interval, tick) =>
        input.active && slot.isCurrent(token) ? scheduler.schedule(interval, tick) : undefined;
      const runCurrent = <A, E>(
        effect: Effect.Effect<A, E, AskUserApplication>,
        signal: AbortSignal | undefined,
        message = "The ask-user session runtime is not active.",
        current = slot.isCurrent(token),
      ) =>
        current
          ? slot.run(effect, signal)
          : Promise.reject(new AskUserRuntimeClosedError({ message }));
      const { ctx } = input;
      input.active = true;
      currentGeneration = input.generation;
      bridge.setContext(ctx);
      const sessionId = invokeHostCallback(() => ctx.sessionManager.getSessionId(), "");
      // Activity is optional; questionnaires still open without it.
      if (sessionId)
        invokeHostCallback(() => input.activity?.activate(pi.events, sessionId), undefined);
      if (sessionId && !requiresQuestionnaireRelay()) {
        try {
          input.revokeCapability = registerQuestionnaireCapability({
            events: pi.events,
            sessionId,
            generation: input.generation,
            isCurrent: () => input.active && slot.isCurrent(token),
            run: (effect, signal) =>
              runCurrent(effect, signal, "The root questionnaire session was replaced."),
          });
        } catch {
          /* Missing host event bus leaves local questionnaires available. */
        }
      }
      if (
        sessionId &&
        ctx.hasUI &&
        (ctx.mode === "tui" || ctx.mode === "rpc") &&
        !requiresQuestionnaireRelay()
      ) {
        try {
          const isCurrent = () =>
            input.active &&
            slot.isCurrent(token) &&
            ctx.sessionManager.getSessionId() === sessionId;
          input.revokeForms = registerOwnedFormCapability({
            events: pi.events,
            sessionId,
            generation: input.generation,
            isCurrent,
            canQueue: () => promptGate.canQueue(),
            run: (effect, signal) =>
              runCurrent(effect, signal, "The owned form session was replaced.", isCurrent()),
          });
        } catch {
          /* Optional local-extension capability. */
        }
      }
      registerAskUserTool(
        pi,
        (request, signal) =>
          runCurrent(askAtQuestionnaireBoundary(pi.events, sessionId, request), signal),
        scheduleAnimation,
      );
      if (ctx.mode === "tui" && !requiresQuestionnaireRelay())
        registerAsyncAskUserTools(
          pi,
          (request, signal) =>
            slot.isCurrent(token) && !promptGate.canQueue()
              ? Promise.reject(asyncBusy())
              : runCurrent(
                  AskUserService.use((service) => service.startAsync(request)),
                  signal,
                ),
          (input, signal) =>
            runCurrent(
              AskUserService.use((service) => service.controlAsync(input)),
              signal,
            ),
          scheduleAnimation,
        );
    },
    onDeactivated: (input) => {
      input.active = false;
      input.revokeCapability?.();
      input.revokeForms?.();
      input.activity?.dispose();
      currentGeneration = undefined;
      bridge.clear();
      bridge.setContext(undefined);
    },
  });

  pi.registerCommand("ask-user", {
    description: "Resume the active hidden questionnaire",
    handler: (_args, ctx) => {
      if (!bridge.resume()) notifyAtHostBoundary(ctx, "No hidden questionnaire is active.", "info");
      return Promise.resolve();
    },
  });

  const startSession = (ctx: ExtensionContext) => {
    historicalDeliveries = captureHistoricalDeliveries(ctx);
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable" || (!ctx.hasUI && !requiresQuestionnaireRelay()))
      return slot.shutdown();
    // ctx.signal belongs to the current agent turn, not this session-owned runtime.
    return slot
      .start({
        ctx,
        cwd: captured.cwd,
        projectTrusted: isProjectTrusted(ctx),
        generation: createQuestionnaireGeneration(),
        active: false,
      })
      .then(() => undefined);
  };
  pi.on("session_start", (_event, ctx) => startSession(ctx));
  pi.on("session_tree", (_event, ctx) => startSession(ctx));
  pi.on("context", (event) => ({
    messages: event.messages.filter((message) =>
      acceptsAsyncMessage(message, currentGeneration, historicalDeliveries),
    ),
  }));

  pi.on("session_shutdown", () => slot.shutdown());
}
