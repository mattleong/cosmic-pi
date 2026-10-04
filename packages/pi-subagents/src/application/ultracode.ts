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

/**
 * Keeps `subagent_workflow` active only while the user has opted into workflows: the ultracode
 * setting is on, or a one-off `/ultracode` window is open. It adds or removes only that tool and
 * leaves every other tool in Pi's active set alone. Its guidance is a system-prompt section of
 * its own, which Pi keeps even under a custom system prompt.
 */
export interface UltracodeController {
  /**
   * The session's tools registered with ultracode at `enabled`. Until the next agent run starts,
   * the workflow tool is only ever added: removing a tool then would drop the tools Pi is still
   * restoring after a reload or `/tree`, so a removal waits for that run.
   */
  readonly activate: (ctx: ExtensionContext, enabled: boolean) => void;
  /** The session's runtime went away; the application deactivates its tools itself. */
  readonly suspend: () => void;
  /** A session boundary forgets the window; the next activation announces its runs again. */
  readonly reset: () => void;
  /** The session's effective ultracode setting changed. */
  readonly setEnabled: (enabled: boolean) => void;
  readonly window: () => UltracodeWindow;
  /** Follows workflow runs for the activation that starts after the latest `reset`. */
  readonly observer: () => WorkflowRunObserver;
  /**
   * Opens the window for `request` and sends it to the main agent as a user message. Pi refuses
   * prompts while it compacts, so a request sent then waits until Pi is idle.
   */
  readonly send: (ctx: ExtensionCommandContext, request: UltracodeRequest) => Promise<void>;
}

const isIdle = (ctx: ExtensionContext): boolean => invokeHostCallback(() => ctx.isIdle(), true);

/** Runs `operation` now and reports its outcome as a promise. */
const settleNow = (operation: () => void): Promise<void> => {
  try {
    operation();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};

/** Registers the Pi events that move the window and returns the controller. */
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
  /** Set from activation until the next agent run starts, while Pi may still restore tools. */
  let restoring = false;

  const optedIn = () => enabled || isUltracodeWindowOpen(state);

  /** Activates the tool when opted in, and deactivates it otherwise unless Pi is restoring. */
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

  const move = (next: UltracodeWindow) => {
    state = next;
    reconcile();
  };

  /** An agent run started, so Pi has finished restoring tools. */
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
  // Runs a notification starts skip before_agent_start; later turns still see the right tools.
  pi.on("agent_start", () => runStarted(ultracodeAgentRunStarted(state)));
  pi.on("agent_settled", () => move(ultracodeAgentRunSettled(state)));

  return {
    activate: (ctx, value) => {
      context = ctx;
      enabled = value;
      restoring = true;
      showStatus();
      reconcile();
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
    setEnabled: (value) => {
      enabled = value;
      showStatus();
      reconcile();
    },
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
          // Pi uses the delivery mode only while an agent run is under way.
          pi.sendUserMessage(ultracodeRequestMessage(request, workflowAuthoringGuidePath()), {
            deliverAs: "followUp",
          });
        } catch (error) {
          if (queued) move(ultracodeRequestUnsent(state));
          throw error;
        }
      };
      // Not idle without an agent run under way means Pi is compacting or summarizing a branch.
      if (state.agentRunning || isIdle(ctx)) return settleNow(deliver);
      return invokeHostCallback(() => ctx.waitForIdle(), Promise.resolve()).then(deliver);
    },
  };
}
