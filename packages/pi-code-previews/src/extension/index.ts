/** Effect-managed Pi boundary for code previews. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { setActivePlatformRunner } from "../boundary/platform";
import {
  makeCodePreviewRuntime,
  setActiveCodePreviewRuntime,
  type CodePreviewRuntime,
} from "../boundary/runtime";
import { ShikiAdapter } from "../boundary/shiki";
import { registerHealthCommand } from "../commands/health";
import { registerSettingsCommand } from "../commands/settings";
import { CodePreviewSession } from "../session-service";
import { codePreviewSettings } from "../settings/index";
import type { CodePreviewToolName } from "../tools/names";
import { registerToolRenderers } from "../tool-renderers/registration";

export interface CodePreviewExtensionDependencies {
  readonly makeRuntime: (pi: ExtensionAPI) => CodePreviewRuntime;
  readonly registerHealth: typeof registerHealthCommand;
  readonly registerSettings: typeof registerSettingsCommand;
  readonly registerRenderers: typeof registerToolRenderers;
}

function clearActiveRuntime(): void {
  setActiveCodePreviewRuntime(undefined);
  setActivePlatformRunner(undefined);
}

const defaultDependencies: CodePreviewExtensionDependencies = {
  makeRuntime: (pi) => {
    const dependencies = Layer.merge(nodeFilePlatformLayer, ShikiAdapter.layer);
    const layer = CodePreviewSession.layer.pipe(Layer.provideMerge(dependencies));
    return makeCodePreviewRuntime(pi, layer) as CodePreviewRuntime;
  },
  registerHealth: registerHealthCommand,
  registerSettings: registerSettingsCommand,
  registerRenderers: registerToolRenderers,
};

export function codePreviews(pi: ExtensionAPI): Promise<void> {
  return codePreviewsWithDependencies(pi, defaultDependencies);
}

/** Internal seam for lifecycle/finalizer tests. */
export function codePreviewsWithDependencies(
  pi: ExtensionAPI,
  dependencies: CodePreviewExtensionDependencies,
): Promise<void> {
  const registeredTools = new Set<CodePreviewToolName>();
  const activatedTools = new Set<CodePreviewToolName>();
  dependencies.registerHealth(pi);
  dependencies.registerSettings(pi);

  let runtime: CodePreviewRuntime | undefined;
  let lifecycle = Promise.resolve();
  let generation = 0;
  let removeAbortListener: (() => void) | undefined;
  const disposals = new WeakMap<CodePreviewRuntime, Promise<void>>();
  const disposeNow = (target: CodePreviewRuntime | undefined) => {
    if (!target) return Promise.resolve();
    const existing = disposals.get(target);
    if (existing) return existing;
    const disposal = target.dispose().catch(() => undefined);
    disposals.set(target, disposal);
    return disposal;
  };
  const clearAbort = () => {
    const remove = removeAbortListener;
    removeAbortListener = undefined;
    try {
      remove?.();
    } catch {
      // Host signal cleanup cannot block runtime disposal.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    const session = ++generation;
    const previous = runtime;
    runtime = undefined;
    clearActiveRuntime();
    clearAbort();
    const previousDisposal = disposeNow(previous);
    lifecycle = lifecycle
      .catch(() => undefined)
      .then(() => previousDisposal)
      .then(() => {
        if (session !== generation) return;
        const next = dependencies.makeRuntime(pi);
        runtime = next;
        setActiveCodePreviewRuntime(runtime);
        setActivePlatformRunner({
          run: (effect, signal) => next.run(effect, signal),
          runShiki: (effect, signal) => next.run(effect, signal),
          forkShiki: (effect) => next.fork(effect),
        });
        const abort = () => {
          if (session !== generation || runtime !== next) return;
          ++generation;
          runtime = undefined;
          clearActiveRuntime();
          clearAbort();
          const disposal = disposeNow(next as CodePreviewRuntime);
          lifecycle = lifecycle.catch(() => undefined).then(() => disposal);
        };
        ctx.signal?.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => ctx.signal?.removeEventListener("abort", abort);
        const projectTrusted =
          typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
        return next
          .run(
            Effect.gen(function* () {
              const service = yield* CodePreviewSession;
              yield* service.loadSettings(ctx.cwd, projectTrusted);
              yield* Effect.sync(() =>
                dependencies.registerRenderers(pi, ctx.cwd, {
                  registeredTools,
                  activatedTools,
                  projectTrusted,
                }),
              );
            }),
            ctx.signal,
          )
          .then(() => {
            if (session !== generation || runtime !== next) return;
            if (codePreviewSettings.syntaxHighlighting)
              next.fork(
                CodePreviewSession.use((service) =>
                  service.initializeSyntax(codePreviewSettings.shikiTheme),
                ),
                ctx.signal,
              );
          });
      })
      .catch(() => {
        if (session !== generation) return;
        const failed = runtime;
        runtime = undefined;
        clearActiveRuntime();
        clearAbort();
        try {
          ctx.ui.notify("Code previews failed to start.", "warning");
        } catch {
          // Host notification failure cannot block disposal.
        }
        return disposeNow(failed);
      });
    return lifecycle;
  });

  pi.on("session_shutdown", () => {
    ++generation;
    const current = runtime;
    runtime = undefined;
    clearActiveRuntime();
    clearAbort();
    const disposal = disposeNow(current);
    lifecycle = lifecycle.catch(() => undefined).then(() => disposal);
    return lifecycle;
  });
  return Promise.resolve();
}
