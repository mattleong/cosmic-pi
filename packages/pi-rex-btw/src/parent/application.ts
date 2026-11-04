import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import {
  loadCodePreviewSettings,
  registerCodePreviewReplay,
  type CodePreviewSettings,
} from "pi-code-previews";
import {
  captureSessionHost,
  invokeHostCallback,
  isProjectTrusted,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import { makePiManagedRuntime } from "pi-cosmic-core/runtime";
import { bestEffortHostBootstrap } from "pi-cosmic-core/runtime/host-bootstrap";
import {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
} from "pi-cosmic-core/runtime/session-runtime";
import { BTW_COMMAND, type ParentReference } from "../launch.ts";
import { isBtwChild, launchedParent } from "../parent-reference.ts";
import { PARENT_TOOL } from "./contract.ts";
import { ParentTranscript } from "./reader.ts";
import { registerParentConversationTool } from "./tool.ts";

/** One line telling the user what the side pane is, short enough for a phone-width pane. */
export const ORIENTATION = {
  sees: "BTW · reads the parent session · nothing goes back",
  blind: "BTW · the parent wasn't saved, so this can't see it",
} as const;

interface ParentRuntimeInput {
  readonly ctx: ExtensionContext;
  readonly parent: ParentReference;
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export interface ParentConversationBoundaries {
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
}

const orient = (ctx: ExtensionContext, message: string): void => {
  if (invokeHostCallback(() => ctx.hasUI && ctx.mode === "tui", false))
    notifyAtHostBoundary(ctx, message, "info");
};

/**
 * Gives a BTW child launched with a parent reference its `parent_conversation` tool, and tells the
 * user what the side pane is when it starts. Other sessions register no tool.
 */
export function registerParentConversation(
  pi: ExtensionAPI,
  { loadSettings }: ParentConversationBoundaries = { loadSettings: loadCodePreviewSettings },
): void {
  const replay = registerCodePreviewReplay(pi, { command: BTW_COMMAND, tools: [PARENT_TOOL] });

  const slot = makePiSessionRuntimeSlot<ParentRuntimeInput, ParentTranscript>({
    makeRuntime: () =>
      makePiManagedRuntime(pi, ParentTranscript.layer, {
        agentDirectory: getAgentDir,
        packageName: "pi-rex-btw",
      }),
    startup: (input) =>
      bestEffortHostBootstrap("pi-rex-btw.preview-settings", (signal) =>
        loadSettings(input.cwd, input.projectTrusted, signal),
      ),
    onActivated: (input, token) => {
      registerParentConversationTool(
        pi,
        input.parent,
        {
          run: (effect, signal) =>
            slot.isCurrent(token)
              ? slot.run(effect, signal)
              : Promise.reject(
                  PiSessionRuntimeError.make({
                    operation: "run",
                    message: "This side session can no longer read its parent",
                  }),
                ),
        },
        replay.shell,
      );
      replay.publish();
    },
  });

  const start = (ctx: ExtensionContext, firstStart: boolean): Promise<void> => {
    const child = isBtwChild(pi);
    const parent = launchedParent(pi);
    if (child && firstStart)
      orient(ctx, parent === undefined ? ORIENTATION.blind : ORIENTATION.sees);
    const host = captureSessionHost(ctx);
    if (parent === undefined || !Predicate.isTagged(host, "Captured") || host.aborted)
      return slot.shutdown();
    return slot
      .start({ ctx, parent, cwd: host.cwd, projectTrusted: isProjectTrusted(ctx) }, host.signal)
      .then(() => undefined);
  };

  pi.on("session_start", (event, ctx) => {
    try {
      return start(ctx, event.reason === "startup").finally(replay.finishStartup);
    } catch (error) {
      replay.finishStartup();
      throw error;
    }
  });

  pi.on("session_shutdown", () => {
    replay.retire();
    return slot.shutdown();
  });
}
