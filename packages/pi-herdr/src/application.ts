import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { loadCodePreviewSettings } from "pi-code-previews";
import {
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { makeHerdrProjectionBridge } from "./boundary/host-ui.ts";
import { HerdrConfigStore } from "./config/store.ts";
import { HerdrService } from "./herd/service.ts";
import {
  makeHerdrLayer,
  type HerdrApplication,
  type HerdrRuntimeError,
  type HerdrSessionInput,
} from "./layer.ts";
import { registerHerdrManagerCommand } from "./settings/controller.ts";
import { HERDR_TOOL_NAMES, registerHerdrTools } from "./tools/herdr.ts";

const HERDR_TOOL_NAME_SET: ReadonlySet<string> = new Set(HERDR_TOOL_NAMES);

interface CapturedActivation extends HerdrSessionInput {
  readonly ctx: ExtensionContext;
}

const deactivateTools = (pi: ExtensionAPI): ReadonlyArray<string> => {
  try {
    const active = pi.getActiveTools();
    const removed = active.filter((name) => HERDR_TOOL_NAME_SET.has(name));
    pi.setActiveTools(active.filter((name) => !HERDR_TOOL_NAME_SET.has(name)));
    return removed;
  } catch {
    return [];
  }
};

const reactivateTools = (pi: ExtensionAPI, names: ReadonlyArray<string>): void => {
  if (names.length === 0) return;
  try {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
  } catch {
    // Stale hosts are best effort during replacement.
  }
};

const notifyFailure = (ctx: ExtensionContext, message: string): void => {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, "error");
  } catch {
    // Host UI may already be stale.
  }
};

export function registerHerdrApplication(pi: ExtensionAPI): void {
  const bridge = makeHerdrProjectionBridge();
  let generation = 0;
  let disabledTools: ReadonlyArray<string> = [];
  let registered = false;

  const rememberDisabled = (names: ReadonlyArray<string>) => {
    disabledTools = [...new Set([...disabledTools, ...names])];
  };

  const slot = makePiSessionRuntimeSlot<
    CapturedActivation,
    HerdrApplication,
    never,
    HerdrRuntimeError
  >({
    makeRuntime: (activation) =>
      makePiManagedRuntime(pi, makeHerdrLayer(activation, { publish: bridge.publish }), {
        agentDirectory: () => activation.agentDirectory,
        packageName: "pi-herdr",
      }),
    startup: () =>
      Effect.gen(function* () {
        const config = yield* HerdrConfigStore;
        const service = yield* HerdrService;
        bridge.setFooterEnabled(config.config.showFooterStatus);
        bridge.publish(yield* service.projection);
      }),
    onActivated: (activation) => {
      bridge.setContext(activation.ctx);
      reactivateTools(pi, disabledTools);
      disabledTools = [];
    },
    onDeactivated: () => {
      rememberDisabled(deactivateTools(pi));
      bridge.clear();
    },
    onStartFailure: (activation) => {
      rememberDisabled(deactivateTools(pi));
      notifyFailure(
        activation.ctx,
        "pi-herdr failed closed. It requires a running Herdr 0.7.5+ session (protocol 17+) and valid pi-herdr configuration. Upgrade or start Herdr, then run /reload.",
      );
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, HerdrApplication>, signal?: AbortSignal) =>
    slot.run(effect, signal);

  registerHerdrManagerCommand(pi, bridge, {
    focus: (id) => run(HerdrService.use((service) => service.focus(id))),
    stop: (id) => run(HerdrService.use((service) => service.stop(id))).then(() => undefined),
    read: (id) =>
      run(HerdrService.use((service) => service.read(id, "recent-unwrapped", 160))).then(
        (result) => result.text,
      ),
  });

  const prepare = (ctx: ExtensionContext): Promise<void> => {
    const currentGeneration = ++generation;
    bridge.clear();
    rememberDisabled(deactivateTools(pi));
    const shutdown = slot.shutdown();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable") return shutdown.then(() => undefined);
    if (captured.aborted)
      return shutdown.then(() => {
        if (currentGeneration === generation)
          notifyFailure(ctx, "pi-herdr did not activate because the session is aborted.");
      });
    let agentDirectory: string;
    try {
      agentDirectory = getAgentDir();
    } catch {
      return shutdown.then(() => {
        if (currentGeneration === generation)
          notifyFailure(ctx, "pi-herdr could not capture the Pi agent directory.");
      });
    }
    const activation: CapturedActivation = {
      ctx,
      cwd: captured.cwd,
      projectTrusted: isProjectTrusted(ctx),
      agentDirectory,
    };
    const settings = Promise.resolve()
      .then(() => loadCodePreviewSettings(activation.cwd, activation.projectTrusted))
      .catch(() => undefined);
    return Promise.all([shutdown, settings])
      .then(() => {
        if (currentGeneration !== generation) return undefined;
        try {
          registerHerdrTools(pi, { run });
          const activatedByRegistration = deactivateTools(pi);
          if (!registered) rememberDisabled(activatedByRegistration);
          registered = true;
        } catch {
          rememberDisabled(deactivateTools(pi));
          notifyFailure(ctx, "pi-herdr tool registration failed.");
          return slot.shutdown().then(() => undefined);
        }
        if (currentGeneration !== generation) return undefined;
        return slot.start(activation, captured.signal).then(() => undefined);
      })
      .then(() => undefined);
  };

  pi.on("session_start", (_event, ctx) => prepare(ctx));
  pi.on("turn_end", (_event, ctx) => bridge.setContext(ctx));
  pi.on("session_tree", (_event, ctx) => prepare(ctx));
  pi.on("session_shutdown", () => {
    ++generation;
    rememberDisabled(deactivateTools(pi));
    bridge.clear();
    return slot.shutdown();
  });
}
