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
import { isRegularFile, registerParentReference } from "./parent-reference.ts";
import { GitBranch } from "./git.ts";
import { isRexBtwError, RexClient } from "./rex.ts";

const PACKAGE_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));

const notify = (ctx: ExtensionContext, message: string, level: HostNotificationLevel): void => {
  if (invokeHostCallback(() => ctx.hasUI, false)) notifyAtHostBoundary(ctx, message, level);
};

/** Reads what the child inherits at the moment /btw runs, since model and session can change. */
const captureRequest = (
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  prompt: string | undefined,
): BtwRequest =>
  invokeHostCallback<BtwRequest>(
    () => {
      const model = ctx.model;
      const sessionFile = ctx.sessionManager.getSessionFile();
      const parent = parseParentReference(ctx.sessionManager.getSessionId(), sessionFile);
      return {
        prompt,
        model: model === undefined ? undefined : { provider: model.provider, id: model.id },
        thinkingLevel: pi.getThinkingLevel(),
        parent: parent !== undefined && isRegularFile(parent.path) ? parent : undefined,
      };
    },
    {
      prompt,
      model: undefined,
      thinkingLevel: undefined,
      parent: undefined,
    },
  );

export default function rexBtw(pi: ExtensionAPI): void {
  registerParentReference(pi);

  const slot = makePiSessionRuntimeSlot<RexBtwInput & { readonly ctx: ExtensionContext }, RexBtw>({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        RexBtw.layer(input).pipe(
          Layer.provide(Layer.merge(RexClient.layer(process.env), GitBranch.layer(process.env))),
        ),
        { agentDirectory: getAgentDir, packageName: "pi-rex-btw" },
      ),
    startup: () => Effect.void,
    onStartFailure: ({ ctx }) => notify(ctx, "Rex BTW couldn't start", "warning"),
  });

  pi.registerCommand(BTW_COMMAND, {
    description: "Open a new side conversation in a Rex pane",
    handler: (args, ctx) => {
      if (invokeHostCallback(() => ctx.mode, undefined) !== "tui") {
        notify(ctx, "Open Pi in an interactive terminal to use /btw", "warning");
        return Promise.resolve();
      }
      if (!slot.isActive()) {
        notify(ctx, REX_UNAVAILABLE_MESSAGE, "error");
        return Promise.resolve();
      }
      const trimmed = Str.trim(args);
      const prompt = trimmed === "" ? undefined : trimmed;
      const problem = prompt === undefined ? undefined : promptProblem(prompt);
      if (problem !== undefined) {
        notify(ctx, problem, "error");
        return Promise.resolve();
      }
      const request = captureRequest(pi, ctx, prompt);
      const isCurrent = slot.captureAuthority();
      return slot.run(RexBtw.use((btw) => btw.open(request))).then(
        () => {
          if (isCurrent() && request.parent === undefined)
            notify(
              ctx,
              "Opened a BTW pane, but it can't see this conversation because this session isn't saved yet",
              "warning",
            );
          return undefined;
        },
        (cause: unknown) => {
          if (isCurrent())
            notify(ctx, isRexBtwError(cause) ? cause.message : "Couldn't open a BTW pane", "error");
          return undefined;
        },
      );
    },
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
