import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { registerExtensionCommand } from "pi-cosmic-core/host-command";
import {
  captureSessionHost,
  invokeHostCallback,
  notifyAtHostBoundary,
  type HostNotificationLevel,
} from "pi-cosmic-core/host-session";
import { makePiManagedRuntime } from "pi-cosmic-core/runtime";
import { makePiSessionRuntimeSlot } from "pi-cosmic-core/runtime/session-runtime";
import { RexBtw, type BtwRequest, type RexBtwInput } from "./btw.ts";
import {
  BTW_COMMAND,
  parseParentReference,
  promptProblem,
  REX_UNAVAILABLE_MESSAGE,
  rexLocation,
} from "./launch.ts";
import { registerParentConversation } from "./parent/application.ts";
import { isRegularFile, registerParentReference } from "./parent-reference.ts";
import { isRexBtwError, RexClient } from "./rex.ts";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

const notify = (ctx: ExtensionContext, message: string, level: HostNotificationLevel): void => {
  if (invokeHostCallback(() => ctx.hasUI, false)) notifyAtHostBoundary(ctx, message, level);
};

/**
 * Reads what the child inherits at the moment /btw runs, since model and session can change.
 * Undefined when this conversation has no saved session file a child could read.
 */
const captureRequest = (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prompt: string | undefined,
): BtwRequest | undefined =>
  invokeHostCallback<BtwRequest | undefined>(() => {
    const model = ctx.model;
    const parent = parseParentReference(
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getSessionFile(),
    );
    return parent !== undefined && isRegularFile(parent.path)
      ? {
          prompt,
          model: model === undefined ? undefined : { provider: model.provider, id: model.id },
          thinkingLevel: pi.getThinkingLevel(),
          parent,
        }
      : undefined;
  }, undefined);

/**
 * Why a BTW pane couldn't read this conversation: Pi writes a session's file with its first
 * message, and a session started without saving never has one.
 */
const unreadableParentMessage = (ctx: ExtensionCommandContext): string => {
  const sessionFile = invokeHostCallback(() => ctx.sessionManager.getSessionFile(), undefined);
  if (sessionFile === undefined) return "BTW can only read a saved session; this one isn't saved";
  return isRegularFile(sessionFile)
    ? "BTW can't read this conversation's session file"
    : "Send a message first so BTW can read this conversation";
};

export default function rexBtw(pi: ExtensionAPI): void {
  registerParentReference(pi);
  registerParentConversation(pi);

  const slot = makePiSessionRuntimeSlot<RexBtwInput & { readonly ctx: ExtensionContext }, RexBtw>({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        RexBtw.layer(input).pipe(Layer.provide(RexClient.layer(process.env))),
        { agentDirectory: getAgentDir, packageName: "pi-rex-btw" },
      ),
    startup: () => Effect.void,
    onStartFailure: ({ ctx }) => notify(ctx, "Rex BTW couldn't start", "warning"),
  });

  /** Opens a side pane, asking `args` there when given; `/btw help` never reaches it. */
  const open = (args: string, ctx: ExtensionCommandContext): Promise<void> | void => {
    if (invokeHostCallback(() => ctx.mode, undefined) !== "tui")
      return notify(ctx, "Open Pi in an interactive terminal to use /btw", "warning");
    if (!slot.isActive()) return notify(ctx, REX_UNAVAILABLE_MESSAGE, "error");
    const trimmed = Str.trim(args);
    const prompt = trimmed === "" ? undefined : trimmed;
    const problem = prompt === undefined ? undefined : promptProblem(prompt);
    if (problem !== undefined) return notify(ctx, problem, "error");
    const request = captureRequest(pi, ctx, prompt);
    // A pane that can't read this conversation can't answer about it, so none opens.
    if (request === undefined) return notify(ctx, unreadableParentMessage(ctx), "warning");
    const isCurrent = slot.captureAuthority();
    return slot.run(RexBtw.use((btw) => btw.open(request))).then(
      () => undefined,
      (cause: unknown) => {
        if (isCurrent())
          notify(ctx, isRexBtwError(cause) ? cause.message : "Couldn't open a BTW pane", "error");
        return undefined;
      },
    );
  };

  registerExtensionCommand(pi, {
    name: BTW_COMMAND,
    description: "Ask a side question in a new Rex pane",
    bare: {
      handler: open,
      text: true,
      description: "Open a side conversation",
      arguments: "[question]",
    },
    overviewNotes: [
      "Add a question to ask it as it opens, for example:",
      "  /btw why does the cart test fail?",
    ],
  });

  pi.on("session_start", (_event, ctx) => {
    const host = captureSessionHost(ctx);
    const environment = process.env;
    const location = rexLocation(environment);
    if (!Predicate.isTagged(host, "Captured") || host.aborted || location === undefined)
      return slot.shutdown();
    return slot
      .start(
        {
          ctx,
          cwd: host.cwd,
          shell: environment.SHELL,
          extensionPath: PACKAGE_DIRECTORY,
          location,
        },
        host.signal,
      )
      .then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
