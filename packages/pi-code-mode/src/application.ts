/** Code Mode session lifecycle, `code_mode` tool registration, and command wiring. */
// Pi session handlers are Promise-shaped host boundaries.
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import {
  loadCodePreviewSettings,
  withCodePreviewShell,
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureHostSignal,
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import {
  makeNestedPiToolDefinitions,
  type NestedPiToolDefinitions,
} from "./boundary/host-builtin-tools.ts";
import {
  captureCodeModeDeactivation,
  codeModeSessionKey,
  publishCodeModeDeactivation,
  type CodeModeSessionKey,
} from "./boundary/host-deactivation-handoff.ts";
import { CodeModeConfigStore, type CodeModeState } from "./config/store.ts";
import {
  makeCodeModeLayer,
  type CodeModeApplication,
  type CodeModeLayerInput,
  type CodeModeRuntimeError,
} from "./layer.ts";
import { registerCodeModeSettingsController } from "./settings/controller.ts";
import {
  buildCodeModeToolDefinition,
  observeCodeModeToolActive,
  reconcileCodeModeToolActivation,
  registerCodeModeTool,
  type CodeModeToolDefinition,
} from "./tools/controller.ts";
import { CodeModeResults, type ResultsContract } from "./results/service.ts";
import { makeCodeModeToolExecute } from "./tools/execution.ts";
import {
  makeHostExecutionOwner,
  type HostExecutionOwner,
} from "./boundary/host-execution-owner.ts";
import {
  applyRetainedCodeModeFailureDetails,
  makeFailureDetailsRetention,
} from "./tools/retention.ts";

interface CodeModeSessionInput extends CodeModeLayerInput {
  readonly ctx: ExtensionContext;
  /** Stable Pi session identity captured once; optional capabilities fail closed without it. */
  readonly sessionId: CodeModeSessionKey | undefined;
  /** Revoked before this session's runtime can finish a late uninterruptible publication. */
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
  /** Disabling revokes execution and result access until the next activation. */
  readonly executionOwner: HostExecutionOwner;
}

/** Host boundaries injected here so tests can control settings latency and nested tools. */
export interface CodeModeApplicationBoundaries {
  /** Must resolve before the tool is wrapped: the preview shell captures mode at wrap time. */
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal: AbortSignal,
  ) => ReturnType<typeof loadCodePreviewSettings>;
  readonly wrapTool: (
    tool: CodeModeToolDefinition,
    scheduleAnimation: CompactAnimationScheduler,
  ) => CodeModeToolDefinition;
  readonly makeNestedDefinitions: (cwd: string) => NestedPiToolDefinitions;
  /** Package-private lifecycle test seam; production always uses `makeCodeModeLayer`. */
  readonly makeLayer?: typeof makeCodeModeLayer;
}

const LIVE_APPLICATION_BOUNDARIES: CodeModeApplicationBoundaries = {
  loadSettings: loadCodePreviewSettings,
  wrapTool: (tool, scheduleAnimation) =>
    withCodePreviewShell(tool, {
      compactSummary: tool.compactSummary,
      expandedContent: tool.expandedContent,
      scheduleAnimation,
    }),
  makeNestedDefinitions: makeNestedPiToolDefinitions,
};

export function registerCodeModeApplication(
  pi: ExtensionAPI,
  boundaries: CodeModeApplicationBoundaries = LIVE_APPLICATION_BOUNDARIES,
): void {
  /**
   * Boundary snapshot of the authoritative resolved configuration. `state.available`
   * (`projectTrusted && config.enabled`) gates `code_mode` registration at session start and
   * is re-read defensively on every tool execution.
   */
  const stateRef = MutableRef.make<CodeModeState | undefined>(undefined);
  /** Whether `code_mode` has ever been registered in this extension process. */
  let hasRegisteredTool = false;
  /** The activation this extension last put in effect (never reflects user changes). */
  let expectedActive = false;
  // Preserve user deactivation by observing membership before lifecycle removal.
  let userDeactivated = false;
  /** Handoff key for the session this instance is currently serving (for publish on exit). */
  let currentSessionKey: CodeModeSessionKey | undefined;

  const failureDetails = makeFailureDetailsRetention();

  // Pi correctly turns a thrown tool error into `isError: true`, but its generic catch path
  // replaces structured details with `{}`. Reattach only details retained by this extension
  // for this exact Code Mode call; content and error semantics remain untouched.
  pi.on("tool_result", (event) => applyRetainedCodeModeFailureDetails(failureDetails, event));

  /** Removes `code_mode` from the active list and records that this extension did so. */
  const tearDownTool = (): void => {
    reconcileCodeModeToolActivation(pi, false);
    expectedActive = false;
  };

  const observeUserIntent = (): void => {
    if (!hasRegisteredTool) return;
    if (observeCodeModeToolActive(pi)) userDeactivated = false;
    else if (expectedActive) userDeactivated = true;
  };

  const slot = makePiSessionRuntimeSlot<
    CodeModeSessionInput,
    CodeModeApplication,
    never,
    CodeModeRuntimeError,
    { readonly scheduler: CodePreviewSchedulerServiceContract; readonly results: ResultsContract }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        Layer.merge(
          (boundaries.makeLayer ?? makeCodeModeLayer)(input, (state) => {
            if (MutableRef.get(input.publicationOwner)) {
              if (!state.available) input.executionOwner.revoke();
              MutableRef.set(stateRef, state);
            }
          }),
          Layer.merge(CodePreviewSchedulerService.layer, CodeModeResults.layer),
        ),
        { agentDirectory: getAgentDir, packageName: "pi-code-mode" },
      ),
    startup: (input) =>
      CodeModeConfigStore.use((store) =>
        store.snapshot().available
          ? bestEffortHostBootstrap("pi-code-mode.preview-settings", (signal) =>
              boundaries.loadSettings(input.cwd, input.projectTrusted, signal),
            )
          : Effect.void,
      ).pipe(
        Effect.andThen(
          Effect.all({ scheduler: CodePreviewSchedulerService, results: CodeModeResults }),
        ),
      ),
    onActivated: (input, token, { scheduler, results }) => {
      const isCurrent = () => MutableRef.get(input.publicationOwner) && slot.isCurrent(token);
      if (!isCurrent()) return;
      const state = MutableRef.get(stateRef);
      if (state === undefined || !state.available) return;
      let wrapped: CodeModeToolDefinition;
      try {
        const definitions = boundaries.makeNestedDefinitions(input.cwd);
        wrapped = boundaries.wrapTool(
          buildCodeModeToolDefinition({
            catalogBudget: state.config.catalogBudget,
            configSnapshot: state.config,
            includePowerShell: definitions.powershell !== undefined,
            execute: makeCodeModeToolExecute({
              results,
              isCurrent: () => isCurrent() && input.executionOwner.current(),
              getState: () => MutableRef.get(stateRef),
              runInSession: (effect, signal) => input.executionOwner.run(effect, signal, slot.run),
              cwd: input.cwd,
              definitions,
              events: pi.events,
              sessionId: input.sessionId,
              retainFailureDetails: failureDetails.retain,
            }),
          }),
          (interval, tick) => (isCurrent() ? scheduler.schedule(interval, tick) : undefined),
        );
      } catch {
        tearDownTool();
        notifyAtHostBoundary(input.ctx, "Code Mode couldn't register its tool", "warning");
        return;
      }
      if (!isCurrent()) return;
      if (!registerCodeModeTool(pi, wrapped)) {
        notifyAtHostBoundary(input.ctx, "Code Mode couldn't register its tool", "warning");
        return;
      }
      hasRegisteredTool = true;
      if (!isCurrent()) {
        tearDownTool();
        return;
      }
      expectedActive = reconcileCodeModeToolActivation(pi, !userDeactivated);
    },
    onDeactivated: (input) => {
      MutableRef.set(input.publicationOwner, false);
      input.executionOwner.revoke();
      MutableRef.set(stateRef, undefined);
      tearDownTool();
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Code Mode couldn't start", "warning");
    },
  });

  registerCodeModeSettingsController(pi, {
    run: slot.run,
    snapshot: () => MutableRef.get(stateRef),
    captureSignal: captureHostSignal,
  });

  const activateSession = (ctx: ExtensionContext): Promise<void> => {
    observeUserIntent();
    // Closure state belongs only to the same stable session. A fresh or unidentifiable session
    // resets to active unless it consumes a matching true-only recreation handoff.
    const sessionKey = codeModeSessionKey(ctx);
    const sameSession = sessionKey !== undefined && sessionKey === currentSessionKey;
    const restored = captureCodeModeDeactivation(sessionKey);
    userDeactivated = (sameSession && userDeactivated) || restored === true;
    currentSessionKey = sessionKey;
    // No registered code_mode implementation may stay exposed while capture, startup,
    // settings, or replacement is pending; a stale definition also self-gates in execute.
    tearDownTool();
    MutableRef.set(stateRef, undefined);

    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") {
      notifyAtHostBoundary(ctx, "Code Mode isn't available in this session", "warning");
      return slot.shutdown().then(() => undefined);
    }
    const projectTrusted = isProjectTrusted(ctx);
    const publicationOwner = MutableRef.make(true);
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted,
          publicationOwner,
          executionOwner: makeHostExecutionOwner(),
          sessionId: sessionKey,
        },
        captured.signal,
      )
      .then(() => undefined);
  };

  pi.on("session_start", (_event, ctx) => activateSession(ctx));
  // Successful tree navigation revokes the old result registry and in-flight publication.
  pi.on("session_tree", (_event, ctx) => activateSession(ctx));

  pi.on("session_shutdown", () => {
    observeUserIntent();
    // Publish against the key captured at start, never a possibly different shutdown context.
    if (userDeactivated) publishCodeModeDeactivation(currentSessionKey);
    currentSessionKey = undefined;
    tearDownTool();
    return slot.shutdown();
  });
}
