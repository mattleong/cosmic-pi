import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  loadCodePreviewSettings,
  registerCodePreviewReplay,
  type CodePreviewSettings,
} from "pi-code-previews";
import { bestEffortHostBootstrap } from "pi-cosmic-core/runtime/host-bootstrap";
import {
  invokeHostCallback,
  isProjectTrusted,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import { isSubagentChildProcess } from "pi-cosmic-core/host-environment";
import { makePiManagedRuntime } from "pi-cosmic-core/runtime";
import {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
} from "pi-cosmic-core/runtime/session-runtime";
import { hostIntercomInbound } from "./boundary/host-inbound.ts";
import { captureIntercomSession } from "./boundary/host-session.ts";
import { INTERCOM_COMMAND, registerIntercomCommand } from "./command.ts";
import { registerIntercomDelivery } from "./delivery.ts";
import { intercomLayer } from "./layer.ts";
import { registerIntercomMessageRenderer } from "./message.ts";
import type { IntercomRegistry } from "./registry/store.ts";
import { IntercomSession, type IntercomSessionInput } from "./session/service.ts";
import { SESSION_TOOL_NAMES } from "./tools/contract.ts";
import { registerSessionTools } from "./tools/register.ts";
import { listSessions } from "./tools/sessions.ts";

/** The macOS `sun_path` limit rules out the usual long per-user temporary directory. */
const FALLBACK_SOCKET_ROOT = "/tmp";
const IDLE_CHECK_INTERVAL = "50 millis";

interface IntercomRuntimeInput {
  readonly ctx: ExtensionContext;
  readonly session: IntercomSessionInput;
  readonly projectTrusted: boolean;
}

export interface IntercomApplicationBoundaries {
  /** Where socket directories go when the agent directory's socket path would be too long. */
  readonly fallbackSocketRoot: string;
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
}

const DEFAULT_BOUNDARIES: IntercomApplicationBoundaries = {
  fallbackSocketRoot: FALLBACK_SOCKET_ROOT,
  loadSettings: loadCodePreviewSettings,
};

/**
 * Registers each interactive or RPC session runtime in the intercom registry, delivers messages
 * from other sessions into it, and gives its main agent the `session_*` tools. Subagent children
 * register nothing: cross-session messaging belongs to main agents.
 */
export function registerIntercomApplication(
  pi: ExtensionAPI,
  boundaries: Partial<IntercomApplicationBoundaries> = {},
): void {
  if (isSubagentChildProcess()) return;
  const { fallbackSocketRoot, loadSettings } = { ...DEFAULT_BOUNDARIES, ...boundaries };

  registerIntercomMessageRenderer(pi);
  const replay = registerCodePreviewReplay(pi, {
    command: INTERCOM_COMMAND,
    tools: SESSION_TOOL_NAMES,
  });
  // The session whose runtime currently receives messages.
  let receiver: ExtensionContext | undefined;
  const delivery = registerIntercomDelivery(pi, {
    isIdle: () => invokeHostCallback(() => receiver?.isIdle() ?? false, false),
    later: (check) => {
      slot.fork(Effect.sleep(IDLE_CHECK_INTERVAL).pipe(Effect.andThen(Effect.sync(check))));
    },
  });

  const slot = makePiSessionRuntimeSlot<IntercomRuntimeInput, IntercomSession | IntercomRegistry>({
    makeRuntime: (input) => {
      receiver = input.ctx;
      // Captured as the runtime is made: any later start, abort, or shutdown retires it.
      const inbound = hostIntercomInbound(input.ctx, slot.captureAuthority(), delivery);
      return makePiManagedRuntime(
        pi,
        intercomLayer(input.session, inbound, { fallbackRoot: fallbackSocketRoot }),
        { agentDirectory: getAgentDir, packageName: "pi-intercom" },
      );
    },
    startup: (input) =>
      bestEffortHostBootstrap("pi-intercom.preview-settings", (signal) =>
        loadSettings(input.session.cwd, input.projectTrusted, signal),
      ).pipe(Effect.andThen(IntercomSession.use(() => Effect.void))),
    onActivated: (_input, token) => {
      registerSessionTools(
        pi,
        {
          run: (effect, signal) =>
            slot.isCurrent(token)
              ? slot.run(effect, signal)
              : Promise.reject(
                  PiSessionRuntimeError.make({
                    operation: "run",
                    message: "Intercom isn't running in this session",
                  }),
                ),
        },
        replay.shell,
      );
      replay.publish();
    },
    onDeactivated: (input) => {
      if (receiver === input.ctx) receiver = undefined;
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Intercom couldn't register this session", "warning");
    },
  });

  registerIntercomCommand(pi, {
    isActive: slot.isActive,
    list: () => slot.run(listSessions()),
    receiving: delivery.receiving,
    setReceiving: delivery.setReceiving,
  });

  const startSession = (ctx: ExtensionContext) => {
    const captured = captureIntercomSession(ctx);
    if (!captured) return slot.shutdown();
    return slot
      .start(
        { ctx, session: captured.session, projectTrusted: isProjectTrusted(ctx) },
        captured.signal,
      )
      .then(() => undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      return startSession(ctx).finally(replay.finishStartup);
    } catch (error) {
      replay.finishStartup();
      throw error;
    }
  });

  pi.on("session_info_changed", (event) => {
    if (!slot.isActive()) return undefined;
    // A failed rewrite leaves the previous name listed; the record stays valid.
    return slot
      .run(
        IntercomSession.use((session) => session.rename(event.name)).pipe(
          Effect.catch(() => Effect.logWarning("Couldn't rewrite the intercom record.")),
        ),
      )
      .catch(() => undefined);
  });

  pi.on("session_shutdown", () => {
    replay.retire();
    return slot.shutdown();
  });
}
