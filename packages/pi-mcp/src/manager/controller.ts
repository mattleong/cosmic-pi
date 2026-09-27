import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  invokeHostCallback,
  makeSynchronousIngress,
  notifyAtHostBoundary,
  countLabel,
} from "pi-cosmic-core";
import { fullScreenKeybindingOptions } from "pi-cosmic-ui/manager/key-labels";
import { McpAuthFlow } from "../auth/flow.ts";
import { makeMcpLoginUi } from "../boundary/host-auth.ts";
import { presentMcpAuthPanel } from "../boundary/host-auth-panel.ts";
import { confirmMcpAction, openMcpOverlay } from "../boundary/host-ui.ts";
import { mcpDiagnostic, type McpDiagnostic } from "../client/diagnostics.ts";
import { boundaryError, McpBoundaryError } from "../client/errors.ts";
import { McpManagerComponent, type McpViewRequest } from "../ui/manager.ts";
import {
  managerSelection,
  type McpManagerSelection,
  type McpManagerClose,
} from "../ui/manager-state.ts";
import { resultPage } from "../ui/result-view.ts";
import type { McpGatewayReply } from "../tools/model.ts";
import { McpExecution } from "../tools/service.ts";
import { McpManager } from "./service.ts";
import type { McpMetadataSummary } from "../discovery/model.ts";

const CommandFailure = Schema.Struct({
  kind: McpBoundaryError.fields.kind,
  reason: McpBoundaryError.fields.reason,
});
/** Success text reads typed discovery metadata; gateway reply data never reaches it. */
export const successfulMcpOutcome = (action: string, metadata?: McpMetadataSummary): string => {
  switch (action) {
    case "connect":
      return "Connected";
    case "disconnect":
      return "Disconnected";
    case "refresh": {
      if (!metadata) return "Refreshed";
      const { tools, support, diagnostics } = metadata;
      const summary = support.tools
        ? `Refreshed: ${countLabel(tools, "tool")}`
        : "Refreshed, but the tool list isn't available";
      return `${summary}${diagnostics.length ? "; some catalogs aren't available" : ""}`;
    }
    case "auth":
      return "Signed in; connect when you're ready";
    case "logout":
      return "Signed out on this machine; the provider wasn't asked to revoke access";
    default:
      return "Done";
  }
};
export const readableMcpOutcome = (reply: McpGatewayReply): string => {
  if (!reply.isError) return successfulMcpOutcome(reply.action);
  const fields = Option.getOrElse(Schema.decodeUnknownOption(CommandFailure)(reply.data), () => ({
    kind: "unavailable" as const,
  }));
  const diagnostic = mcpDiagnostic({ ...fields, outcome: reply.outcome }, { action: reply.action });
  return mcpDiagnosticNotice(diagnostic);
};

/** A diagnostic as a one-line notice; its explanation stays in the /mcp dashboard. */
export const mcpDiagnosticNotice = (diagnostic: McpDiagnostic): string =>
  `${diagnostic.title}; open /mcp for details`;

/** One outer session Effect owns subscriptions, local read workers, overlays and confirmation. */
export const runMcpManager = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  current: () => boolean,
  initial: McpManagerSelection = managerSelection(),
) =>
  Effect.gen(function* () {
    if (!invokeHostCallback(() => ctx.mode === "tui", false))
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "The MCP manager requires TUI. Use gateway discovery for machine access.",
      );
    const manager = yield* McpManager;
    const execution = yield* McpExecution;
    const flow = yield* McpAuthFlow;
    return yield* manager.withView(
      Effect.gen(function* () {
        let selection = initial;
        while (invokeHostCallback(current, false)) {
          yield* manager.refresh;
          const chosen = yield* Effect.scoped(
            Effect.gen(function* () {
              let component: McpManagerComponent | undefined;
              let opening = true;
              const ingress = yield* makeSynchronousIngress<McpViewRequest, never, never>({
                capacity: 1,
                overflow: "coalesce-latest",
                handle: (request) => {
                  const deliver = <A, E>(
                    load: Effect.Effect<A | undefined, E>,
                    callback: (value: A | undefined) => void,
                  ) =>
                    load.pipe(
                      Effect.orElseSucceed(() => undefined),
                      Effect.flatMap((value) =>
                        Effect.sync(() => {
                          if (opening && invokeHostCallback(current, false))
                            invokeHostCallback(() => callback(value), undefined);
                        }),
                      ),
                    );
                  if (request.kind === "cached")
                    return deliver(manager.cached(request.request), request.deliver);
                  if (request.kind === "detail")
                    return deliver(manager.cachedDetail(request.ref), request.deliver);
                  const { id, offset } = request;
                  return deliver(
                    execution
                      .execute(
                        { action: "result.read", id, offset, limit: 8192 },
                        { maxOutputBytes: 16_384, images: false },
                      )
                      .pipe(Effect.map((result) => resultPage(result.reply))),
                    request.deliver,
                  );
                },
              }).pipe(Effect.orDie);
              yield* manager.subscribe(() =>
                invokeHostCallback(() => component?.update(), undefined),
              );
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  opening = false;
                  component?.dispose();
                }),
              );
              return yield* openMcpOverlay<McpManagerClose>(
                ctx,
                current,
                ({ tui, theme, keybindings, getHeight, finish }) => {
                  component = new McpManagerComponent({
                    theme,
                    selection,
                    snapshot: manager.snapshot,
                    height: getHeight,
                    requestRender: () => tui.requestRender(),
                    finish,
                    load: (request) => {
                      ingress.offer(request);
                    },
                    ...fullScreenKeybindingOptions(keybindings),
                  });
                  return component;
                },
              );
            }),
          );
          if (!chosen || !current()) return;
          selection = chosen.selection;
          const result = yield* Effect.result(
            Effect.gen(function* () {
              const ticket = yield* manager.capture(chosen.row, chosen.action);
              if (
                ticket.confirmation &&
                !(yield* confirmMcpAction(ctx, ticket.confirmation, current))
              )
                return;
              yield* manager.check(ticket);
              let metadata: McpMetadataSummary | undefined;
              if (ticket.action === "auth") {
                yield* flow.run(
                  ticket.binding.server,
                  makeMcpLoginUi(pi, ctx, false, current),
                  (attempt) => presentMcpAuthPanel(ctx, attempt, current),
                  ticket.binding,
                );
              } else metadata = yield* manager.dispatch(ticket);
              if (current())
                notifyAtHostBoundary(ctx, successfulMcpOutcome(ticket.action, metadata), "info");
            }),
          );
          if (result._tag === "Failure" && current()) {
            const diagnostic = mcpDiagnostic(result.failure, { action: chosen.action });
            notifyAtHostBoundary(ctx, mcpDiagnosticNotice(diagnostic), diagnostic.severity);
          }
        }
      }),
    );
  });

/** Completion uses only IDs from the already-published safe snapshot. */
export const mcpCompletions = (prefix: string, ids: ReadonlyArray<string>) => {
  if (prefix.length > 256) return null;
  const commands = [
    "status",
    "browse",
    "result",
    "connect",
    "disconnect",
    "refresh",
    "auth",
    "logout",
  ];
  const match = /^(connect|disconnect|refresh|auth|logout|browse)\s+(\S*)$/.exec(prefix);
  const candidates = match
    ? ids.filter((id) => id.startsWith(match[2]!)).map((id) => `${match[1]} ${id}`)
    : commands.filter((command) => command.startsWith(prefix));
  return candidates.length
    ? candidates.slice(0, 100).map((value) => ({ value, label: value }))
    : null;
};
