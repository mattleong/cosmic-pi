import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { invokeHostCallback, makeSynchronousIngress, notifyAtHostBoundary } from "pi-cosmic-core";
import { fullScreenKeybindingLabel } from "pi-cosmic-ui/manager/key-labels";
import { McpAuthFlow } from "../auth/flow.ts";
import { makeMcpLoginUi } from "../boundary/host-auth.ts";
import { presentMcpAuthPanel } from "../boundary/host-auth-panel.ts";
import { confirmMcpAction, openMcpOverlay } from "../boundary/host-ui.ts";
import { mcpDiagnostic } from "../client/diagnostics.ts";
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

const CommandFailure = Schema.Struct({
  kind: McpBoundaryError.fields.kind,
  reason: McpBoundaryError.fields.reason,
});
export const readableMcpOutcome = (reply: McpGatewayReply): string => {
  if (reply.isError) {
    const fields = Option.getOrElse(Schema.decodeUnknownOption(CommandFailure)(reply.data), () => ({
      kind: "unavailable" as const,
    }));
    const diagnostic = mcpDiagnostic({ ...fields, outcome: reply.outcome });
    return `${diagnostic.title}. ${diagnostic.explanation}`;
  }
  switch (reply.action) {
    case "connect":
      return "Connected. Metadata was not discovered. This is not a health check.";
    case "disconnect":
      return "Disconnected. Completed results remain available until eviction or authority revocation.";
    case "refresh":
      return "Metadata refreshed. No tools were invoked.";
    case "auth":
      return "Credentials verified locally. Connect separately when ready.";
    case "logout":
      return "Local credentials removed. Connections and output access revoked. No provider-side revocation was requested.";
    default:
      return "MCP command completed.";
  }
};

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
                  const deliver = <A>(value: A, callback: (input: A) => void) =>
                    Effect.sync(() => {
                      if (opening && invokeHostCallback(current, false))
                        invokeHostCallback(() => callback(value), undefined);
                    });
                  if (request.kind === "cached")
                    return manager.cached(request.request).pipe(
                      Effect.matchEffect({
                        onSuccess: (page) => deliver(page, request.deliver),
                        onFailure: () => deliver(undefined, request.deliver),
                      }),
                    );
                  if (request.kind === "detail")
                    return manager.cachedDetail(request.ref).pipe(
                      Effect.matchEffect({
                        onSuccess: (detail) => deliver(detail, request.deliver),
                        onFailure: () => deliver(undefined, request.deliver),
                      }),
                    );
                  return execution
                    .execute(
                      {
                        action: "result.read",
                        id: request.id,
                        offset: request.offset,
                        limit: 8192,
                      },
                      { maxOutputBytes: 16_384, images: false },
                    )
                    .pipe(
                      Effect.matchEffect({
                        onSuccess: (result) => deliver(resultPage(result.reply), request.deliver),
                        onFailure: () => deliver(undefined, request.deliver),
                      }),
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
                ({ tui, theme, keybindings, finish }) => {
                  component = new McpManagerComponent({
                    theme,
                    selection,
                    snapshot: manager.snapshot,
                    height: () => Math.max(3, tui.terminal.rows - 2),
                    requestRender: () => tui.requestRender(),
                    finish,
                    load: (request) => {
                      ingress.offer(request);
                    },
                    matchesKeybinding: (data, id) => keybindings.matches(data, id),
                    keybindingLabel: (id, fallback) =>
                      fullScreenKeybindingLabel(id, fallback, (key) => keybindings.getKeys(key)),
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
              if (ticket.action === "auth") {
                yield* flow.run(
                  ticket.binding.server,
                  makeMcpLoginUi(pi, ctx, false, current),
                  (attempt) => presentMcpAuthPanel(ctx, attempt, current),
                  ticket.binding,
                );
              } else yield* manager.dispatch(ticket);
              if (current())
                notifyAtHostBoundary(
                  ctx,
                  readableMcpOutcome({
                    action: ticket.action,
                    outcome: "completed",
                    isError: false,
                    data: null,
                    notices: [],
                  }),
                  "info",
                );
            }),
          );
          if (result._tag === "Failure" && current()) {
            const diagnostic = mcpDiagnostic(result.failure);
            notifyAtHostBoundary(
              ctx,
              `${diagnostic.title}. ${diagnostic.explanation}`,
              diagnostic.severity,
            );
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
