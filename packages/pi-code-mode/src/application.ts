/** Code Mode session lifecycle, `code_mode` tool registration, and command wiring. */
// Pi session handlers are Promise-shaped host boundaries.
// @effect-diagnostics effect/asyncFunction:off
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import {
  makeNestedPiToolDefinitions,
  type NestedPiToolDefinitions,
} from "./boundary/host-builtin-tools.ts";
import {
  codeModeSessionKey,
  makeCodeModeDeactivationHandoff,
  type CodeModeSessionKey,
} from "./boundary/host-deactivation-handoff.ts";
import { notifyAtHostBoundary } from "./boundary/host-notifier.ts";
import {
  captureHostSignal,
  captureSessionHost,
  isProjectTrusted,
} from "./boundary/host-session.ts";
import { CodeModeConfigStore, type CodeModeState } from "./config/store.ts";
import {
  makeCodeModeLayer,
  type CodeModeApplication,
  type CodeModeRuntimeError,
  type CodeModeSessionInput,
} from "./layer.ts";
import { registerCodeModeSettingsController } from "./settings/controller.ts";
import {
  buildCodeModeToolDefinition,
  deactivateCodeModeTool,
  observeCodeModeToolActive,
  reconcileCodeModeToolActivation,
  registerCodeModeTool,
  type CodeModeToolDefinition,
} from "./tools/controller.ts";
import { makeCodeModeToolExecute } from "./tools/execution.ts";

/** Host boundaries injected here so tests can control settings latency and nested tools. */
export interface CodeModeApplicationBoundaries {
  /** Must resolve before the tool is wrapped: the preview shell captures mode at wrap time. */
  readonly loadSettings: (cwd: string, projectTrusted: boolean) => Promise<unknown>;
  readonly wrapTool: (tool: CodeModeToolDefinition) => CodeModeToolDefinition;
  readonly makeNestedDefinitions: (cwd: string) => NestedPiToolDefinitions;
  /**
   * Process-memory bridge for the deliberate deactivation intent across module recreation.
   * Defaults to the globalThis-backed handoff; every instance shares one slot, so a recreated
   * module restores what the old module published (see `host-deactivation-handoff.ts`).
   */
  readonly makeDeactivationHandoff?: () => ReturnType<typeof makeCodeModeDeactivationHandoff>;
}

const LIVE_APPLICATION_BOUNDARIES: CodeModeApplicationBoundaries = {
  loadSettings: loadCodePreviewSettings,
  wrapTool: (tool) => withCodePreviewShell(tool),
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
  /** Bumped by every session boundary; stale async continuations compare against it. */
  let preparationGeneration = 0;
  /** Whether `code_mode` has ever been registered in this extension process. */
  let hasRegisteredTool = false;
  /** The activation this extension last put in effect (never reflects user changes). */
  let expectedActive = false;
  /**
   * Deliberate-deactivation policy: Pi keeps a dynamically registered tool's activation
   * across re-registration but offers no unregister, so this extension removes only
   * `code_mode` at session boundaries and re-adds it after re-registering. A user who
   * deactivated the tool mid-session is observed here — active-list membership is read
   * *before* any lifecycle removal in the same cycle — and their choice is preserved by
   * re-registering without re-activating. Re-activating the tool clears the observation.
   */
  let userDeactivated = false;
  /** Handoff key for the session this instance is currently serving (for publish on exit). */
  let currentSessionKey: CodeModeSessionKey | undefined;

  const handoff = (boundaries.makeDeactivationHandoff ?? makeCodeModeDeactivationHandoff)();

  const observeUserIntent = (): void => {
    if (!hasRegisteredTool) return;
    if (observeCodeModeToolActive(pi)) userDeactivated = false;
    else if (expectedActive) userDeactivated = true;
  };

  /**
   * Publish the observed deactivation intent so a module Pi recreates on the next
   * reload/new/resume/fork can restore it. Keyed by stable session identity where available.
   */
  const publishUserIntent = (key: CodeModeSessionKey | undefined): void => {
    if (key !== undefined) handoff.publish(key, userDeactivated);
  };

  const slot = makePiSessionRuntimeSlot<
    CodeModeSessionInput,
    CodeModeApplication,
    never,
    CodeModeRuntimeError
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeCodeModeLayer(input, {
          publish: (state) => MutableRef.set(stateRef, state),
        }),
        { agentDirectory: getAgentDir, packageName: "pi-code-mode" },
      ),
    startup: () => CodeModeConfigStore.use(() => Effect.void),
    onDeactivated: () => {
      MutableRef.set(stateRef, undefined);
      deactivateCodeModeTool(pi);
      expectedActive = false;
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Code Mode failed to start.", "warning");
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, CodeModeApplication>, signal?: AbortSignal) =>
    slot.run(effect, signal);

  registerCodeModeSettingsController(pi, {
    run,
    snapshot: () => MutableRef.get(stateRef),
    captureSignal: captureHostSignal,
  });

  const activateSession = async (ctx: ExtensionContext): Promise<void> => {
    const generation = ++preparationGeneration;
    observeUserIntent();
    // Restore a deliberate deactivation this session recorded before Pi recreated the
    // extension module (reload/new/resume/fork). The handoff is keyed by stable session
    // identity, so a genuinely different session never inherits another's intent; a fresh
    // session with no published intent leaves the default (activated).
    const sessionKey = codeModeSessionKey(ctx);
    currentSessionKey = sessionKey;
    const restored = handoff.capture(sessionKey);
    if (restored !== undefined) userDeactivated = restored;
    // No registered code_mode implementation may stay exposed while capture, startup,
    // settings, or replacement is pending; a stale definition also self-gates in execute.
    deactivateCodeModeTool(pi);
    expectedActive = false;
    MutableRef.set(stateRef, undefined);

    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") {
      notifyAtHostBoundary(ctx, "Code Mode is unavailable for this session.", "warning");
      await slot.shutdown();
      return;
    }
    const projectTrusted = isProjectTrusted(ctx);
    const token = await slot.start({ ctx, cwd: captured.cwd, projectTrusted }, captured.signal);
    // Start failure already notified via onStartFailure; a superseded start stays silent.
    if (token === undefined) return;
    if (generation !== preparationGeneration || !slot.isCurrent(token)) return;

    const state = MutableRef.get(stateRef);
    // Untrusted or disabled sessions register nothing; the tool stays deactivated.
    if (state === undefined || !state.available) return;

    try {
      // Trusted project settings must finish loading before the wrap below: the preview
      // shell captures its mode at wrapping time.
      await boundaries.loadSettings(captured.cwd, projectTrusted);
    } catch {
      // Preview-settings failures degrade to preview defaults; they never block the tool.
    }
    // A slow settings load must never register an implementation bound to a replaced
    // session (old cwd, old runtime): re-check currency after every await.
    if (generation !== preparationGeneration || !slot.isCurrent(token)) return;

    const isCurrent = () => generation === preparationGeneration && slot.isCurrent(token);
    const definition = buildCodeModeToolDefinition({
      catalogBudget: state.config.catalogBudget,
      execute: makeCodeModeToolExecute({
        isCurrent,
        getState: () => MutableRef.get(stateRef),
        runInSession: (effect, signal) => slot.run(effect, signal),
        definitions: boundaries.makeNestedDefinitions(captured.cwd),
      }),
    });
    let wrapped: CodeModeToolDefinition;
    try {
      wrapped = boundaries.wrapTool(definition);
    } catch {
      notifyAtHostBoundary(ctx, "Code Mode failed to register its tool.", "warning");
      return;
    }
    if (!registerCodeModeTool(pi, wrapped)) {
      notifyAtHostBoundary(ctx, "Code Mode failed to register its tool.", "warning");
      return;
    }
    hasRegisteredTool = true;
    expectedActive = reconcileCodeModeToolActivation(pi, !userDeactivated);
  };

  pi.on("session_start", (_event, ctx) => activateSession(ctx));

  pi.on("session_shutdown", (_event, ctx: ExtensionContext | undefined) => {
    ++preparationGeneration;
    observeUserIntent();
    // Publish the observed intent before teardown so a module Pi recreates on the following
    // reload/new/resume/fork restores it. Prefer the shutdown ctx's identity, falling back to
    // the key captured at this session's start.
    publishUserIntent((ctx ? codeModeSessionKey(ctx) : undefined) ?? currentSessionKey);
    deactivateCodeModeTool(pi);
    expectedActive = false;
    return slot.shutdown();
  });
}
