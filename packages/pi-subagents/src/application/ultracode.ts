import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import {
  makeFooterStatusDeclaration,
  makeSetStatusSafely,
} from "pi-cosmic-ui/boundary/host-status";
import { workflowAuthoringGuidePath } from "../boundary/workflow-authoring-guide.ts";
import { WORKFLOW_TOOL_NAME } from "../tools/workflow-schema.ts";
import { ultracodeGuideline, type UltracodeGuidance } from "../ultracode/guidance.ts";
import {
  carriesUltracodeRequest,
  ultracodeRequestMessage,
  type UltracodeRequest,
} from "../ultracode/request.ts";
import type { WorkflowRunObserver } from "../workflow/run-observer.ts";
import {
  closedUltracodeWindow,
  isUltracodeWindowOpen,
  ultracodeAgentRunSettled,
  ultracodeAgentRunStarted,
  ultracodePromptRunStarted,
  ultracodeRequestSent,
  ultracodeRequestUnsent,
  ultracodeWindowReset,
  ultracodeWorkflowRunClosed,
  ultracodeWorkflowRunOpened,
  type UltracodeWindow,
} from "./ultracode-window.ts";

const STATUS_KEY = "pi-subagents-ultracode";

export interface UltracodeController {
  readonly activate: (ctx: ExtensionContext, enabled: boolean) => void;
  readonly suspend: () => void;
  readonly reset: () => void;
  readonly setEnabled: (enabled: boolean) => void;
  readonly window: () => UltracodeWindow;
  readonly observer: () => WorkflowRunObserver;
  readonly send: (ctx: ExtensionCommandContext, request: UltracodeRequest) => Promise<void>;
}

const isIdle = (ctx: ExtensionContext): boolean => invokeHostCallback(() => ctx.isIdle(), true);

export function registerUltracodeController(
  pi: Pick<ExtensionAPI, "on" | "events" | "getActiveTools" | "setActiveTools" | "sendUserMessage">,
): UltracodeController {
  const setStatus = makeSetStatusSafely(STATUS_KEY);
  const footer = makeFooterStatusDeclaration({
    events: pi.events,
    owner: STATUS_KEY,
    statusKey: STATUS_KEY,
    placement: { region: "identity", order: 150 },
  });
  let context: ExtensionContext | undefined;
  let enabled = false;
  let state = closedUltracodeWindow;
  let epoch = 0;
  let restoring = false;

  const optedIn = () => enabled || isUltracodeWindowOpen(state);

  const reconcile = () => {
    if (!context) return;
    const wanted = optedIn();
    invokeHostCallback(() => {
      const active = pi.getActiveTools();
      const present = active.includes(WORKFLOW_TOOL_NAME);
      if (wanted && !present) pi.setActiveTools([...active, WORKFLOW_TOOL_NAME]);
      else if (!wanted && present && !restoring)
        pi.setActiveTools(active.filter((name) => name !== WORKFLOW_TOOL_NAME));
    }, undefined);
  };

  const showStatus = () => {
    if (context && enabled) {
      setStatus(context, "ultracode");
      footer.activate(context);
      return;
    }
    setStatus(context, undefined);
    footer.shutdown();
  };

  const setEnabled = (value: boolean) => {
    enabled = value;
    showStatus();
    reconcile();
  };

  const move = (next: UltracodeWindow) => {
    state = next;
    reconcile();
  };

  const runStarted = (next: UltracodeWindow) => {
    restoring = false;
    move(next);
  };

  const guidance = (request: boolean): UltracodeGuidance | undefined => {
    if (enabled) return "standing";
    if (request) return "request";
    return isUltracodeWindowOpen(state) ? "runs" : undefined;
  };

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    const carries = carriesUltracodeRequest(event.prompt);
    const request = carries && state.queuedRequests > 0;
    runStarted(ultracodePromptRunStarted(state, carries));
    const sections = event.systemPromptOptions.sections;
    delete sections.subagents_ultracode;
    const current = guidance(request);
    if (context && current)
      sections.subagents_ultracode = ultracodeGuideline(current, workflowAuthoringGuidePath());
  });
  pi.on("agent_start", () => runStarted(ultracodeAgentRunStarted(state)));
  pi.on("agent_settled", () => move(ultracodeAgentRunSettled(state)));

  return {
    activate: (ctx, value) => {
      context = ctx;
      restoring = true;
      setEnabled(value);
    },
    suspend: () => {
      setStatus(context, undefined);
      footer.shutdown();
      context = undefined;
    },
    reset: () => {
      epoch += 1;
      state = ultracodeWindowReset(state);
    },
    setEnabled,
    window: () => state,
    observer: () => {
      const owner = epoch;
      return {
        opened: (runId) => {
          if (owner === epoch) move(ultracodeWorkflowRunOpened(state, runId));
        },
        closed: (runId, handoff) => {
          if (owner === epoch) move(ultracodeWorkflowRunClosed(state, runId, handoff));
        },
      };
    },
    send: (ctx, request) => {
      const owner = epoch;
      const deliver = () => {
        if (owner !== epoch || !context) throw new Error("The session changed before sending");
        const sent = ultracodeRequestSent(state);
        const queued = sent.queuedRequests > state.queuedRequests;
        move(sent);
        try {
          pi.sendUserMessage(ultracodeRequestMessage(request, workflowAuthoringGuidePath()), {
            deliverAs: "followUp",
          });
        } catch (error) {
          if (queued) move(ultracodeRequestUnsent(state));
          throw error;
        }
      };
      if (!state.agentRunning && !isIdle(ctx))
        return invokeHostCallback(() => ctx.waitForIdle(), Promise.resolve()).then(deliver);
      try {
        deliver();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
