import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  captureHostSignal,
  invokeHostCallback,
  isProjectTrusted,
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import type { McpCommandPort } from "../application/lifecycle.ts";
import { McpAuth } from "../auth/service.ts";
import { McpAuthFlow } from "../auth/flow.ts";
import { presentMcpAuthPanel } from "../boundary/host-auth-panel.ts";
import { confirmMcpAction } from "../boundary/host-ui.ts";
import { McpManager } from "../manager/service.ts";
import { mcpCompletions, readableMcpOutcome, runMcpManager } from "../manager/controller.ts";
import { managerSelection } from "../ui/manager-state.ts";
import { makeMcpLoginUi, mcpHasLoginUi } from "../boundary/host-auth.ts";
import { boundedMcpReply, mcpFailureReply } from "../boundary/host-tool-result.ts";
import { boundaryError } from "../client/errors.ts";
import type { McpConfigScope, McpResolvedConfig } from "../config/model.ts";
import { McpConfigStore } from "../config/store.ts";
import { MCP_INLINE_BYTES, type McpGatewayReply } from "../tools/model.ts";
import { McpExecution } from "../tools/service.ts";

const invalid = () => boundaryError("invalid-input", "not-sent", "Invalid MCP command arguments.");
const denied = () => boundaryError("denied", "not-sent", "MCP command requires a trusted session.");
const reply = (action: string, data: Schema.Json): McpGatewayReply => ({
  action,
  outcome: "completed",
  isError: false,
  data,
  notices: [],
});
const gate = (ctx: ExtensionContext, current: () => boolean, trusted: boolean) =>
  Effect.suspend(() => {
    if (!invokeHostCallback(current, false))
      return Effect.fail(boundaryError("stale", "not-sent", "MCP command was revoked."));
    return !trusted || isProjectTrusted(ctx) ? Effect.void : Effect.fail(denied());
  });

/** Deliberately omit endpoints, commands, arguments, paths, environment values, and credential identities. */
export const mcpConfigMetadata = (config: McpResolvedConfig): Schema.Json => ({
  revision: config.revision,
  trusted: config.trusted,
  settings: { ...config.settings },
  servers: Object.values(config.servers).map((server) => ({
    id: server.id,
    scope: server.scope,
    enabled: server.enabled,
    transport: server.definition?.transport ?? null,
    invalid: server.diagnostic !== undefined,
  })),
  diagnosticCount: config.diagnostics.length,
});

export const runMcpUserCommand = (
  args: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  current: () => boolean,
) =>
  Effect.gen(function* () {
    if (args.length > 4_096) return yield* invalid();
    const words = args.trim().split(/\s+/);
    const action = words[0] || "status";
    yield* gate(ctx, current, action !== "status" && action !== "browse" && action !== "result");
    const execution = yield* McpExecution;
    if (action === "status" && words.length === 1)
      return (yield* execution.execute(
        { action },
        { maxOutputBytes: MCP_INLINE_BYTES, images: false },
      )).reply;
    const server = words[1];
    if (
      (action === "browse" && words.length <= 2) ||
      (action === "result" && words.length === 2 && server)
    ) {
      yield* runMcpManager(
        pi,
        ctx,
        current,
        action === "browse"
          ? managerSelection("browse", server)
          : managerSelection("result", undefined, server),
      );
      return reply("view", null);
    }
    if (!server || server.length > 128) return yield* invalid();
    if (
      ctx.mode === "tui" &&
      (action === "connect" ||
        action === "disconnect" ||
        action === "refresh" ||
        action === "logout") &&
      words.length === 2
    ) {
      const manager = yield* McpManager;
      const row = (yield* manager.refresh).servers.find((entry) => entry.id === server);
      if (!row) return yield* invalid();
      const ticket = yield* manager.capture(row, action);
      if (ticket.confirmation && !(yield* confirmMcpAction(ctx, ticket.confirmation, current)))
        return reply("view", null);
      yield* gate(ctx, current, true);
      yield* manager.dispatch(ticket);
      return reply(action, null);
    }
    if (["connect", "disconnect", "refresh"].includes(action) && words.length === 2) {
      return (yield* execution.execute(
        { action, server },
        { maxOutputBytes: MCP_INLINE_BYTES, images: false },
      )).reply;
    }
    if (action === "logout" && words.length === 2) {
      yield* execution.logout(server);
      yield* gate(ctx, current, true);
      return reply("logout", { state: "removed", providerRevocation: false });
    }
    if (action !== "auth" || words.length > 3 || (words.length === 3 && words[2] !== "--manual"))
      return yield* invalid();
    if (!mcpHasLoginUi(ctx)) {
      // A user may verify an already stored grant in print/JSON mode, but this path
      // never creates a callback listener or asks the SDK to start interactive login.
      const config = yield* McpConfigStore.use((store) => store.snapshot);
      const definition = config.servers[server];
      if (!config.trusted || !config.settings.enabled || !definition?.enabled)
        return yield* denied();
      yield* McpAuth.use((auth) => auth.access(definition, { requireGrant: true })).pipe(
        Effect.filterOrFail(
          (token) => token !== undefined,
          () => boundaryError("auth-required", "not-sent", "No managed credential is available."),
        ),
        Effect.mapError(() =>
          boundaryError(
            "unavailable",
            "not-sent",
            "MCP authentication requires an interactive user dialog.",
          ),
        ),
      );
      yield* gate(ctx, current, true);
      return reply("auth", { state: "ready" });
    }
    const flow = yield* McpAuthFlow;
    const present =
      ctx.mode === "tui"
        ? (attempt: Parameters<typeof presentMcpAuthPanel>[1]) =>
            presentMcpAuthPanel(ctx, attempt, current)
        : undefined;
    const status = yield* flow.run(
      server,
      makeMcpLoginUi(pi, ctx, words[2] === "--manual", current),
      present,
    );
    yield* gate(ctx, current, true);
    return reply("auth", { state: status.state });
  });

export const runMcpSettingsCommand = (
  args: string,
  ctx: ExtensionContext,
  current: () => boolean,
) =>
  Effect.gen(function* () {
    if (Buffer.byteLength(args, "utf8") > 1024 * 1024) return yield* invalid();
    const text = args.trim();
    const store = yield* McpConfigStore;
    if (text === "" || text === "show") {
      yield* gate(ctx, current, false);
      return reply("settings.show", mcpConfigMetadata(yield* store.snapshot));
    }
    yield* gate(ctx, current, true);
    if (text === "reload") return reply("settings.reload", mcpConfigMetadata(yield* store.reload));
    const match = /^(set-server|remove-server|set-settings)\s+(global|project)\s+([\s\S]+)$/.exec(
      text,
    );
    if (!match) return yield* invalid();
    const action = match[1];
    const scope: McpConfigScope = match[2] === "global" ? "global" : "project";
    const rest = match[3]!;
    const json = (value: string) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(value).pipe(
        Effect.mapError(invalid),
      );
    let config: McpResolvedConfig;
    if (action === "set-settings") config = yield* store.setSettings(scope, yield* json(rest));
    else if (action === "remove-server") {
      if (/\s/.test(rest) || rest.length > 128) return yield* invalid();
      config = yield* store.removeServer(scope, rest);
    } else {
      const server = /^(\S+)\s+([\s\S]+)$/.exec(rest);
      if (!server || server[1]!.length > 128) return yield* invalid();
      config = yield* store.setServer(scope, server[1]!, yield* json(server[2]!));
    }
    yield* gate(ctx, current, true);
    return reply(`settings.${action}`, mcpConfigMetadata(config));
  });

/** Keep only recognized command syntax in failure context, never raw arguments. */
const commandFailureAction = (args: string): string => {
  if (args.length > 4_096) return "command";
  const words = args.trim().split(/\s+/);
  const action = words[0] || "status";
  if (action === "status" && words.length === 1) return action;
  const server = words[1];
  if (!server || server.length > 128) return "command";
  if (
    ["connect", "disconnect", "refresh", "logout", "browse", "result"].includes(action) &&
    words.length === 2
  )
    return action;
  if (action === "auth" && (words.length === 2 || (words.length === 3 && words[2] === "--manual")))
    return action;
  return "command";
};

/** User command publication is generation checked and never prints exception diagnostics. */
const commandHandler =
  (pi: ExtensionAPI, port: McpCommandPort, settings: boolean) =>
  (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const current = port.capture(ctx);
    const signal = captureHostSignal(ctx);
    if (!current() || signal._tag === "Unavailable") {
      notifyAtHostBoundary(ctx, "MCP is unavailable for this session.", "warning");
      return Promise.resolve();
    }
    const failureAction = settings ? "settings" : commandFailureAction(args);
    const effect = settings
      ? runMcpSettingsCommand(args, ctx, current)
      : args.trim() === "" && ctx.mode === "tui"
        ? runMcpManager(pi, ctx, current).pipe(Effect.as(reply("view", null)))
        : runMcpUserCommand(args, pi, ctx, current);
    return port
      .run(Effect.result(effect), signal.signal)
      .then(
        (result) =>
          Result.isSuccess(result)
            ? result.success
            : mcpFailureReply(failureAction, result.failure),
        () =>
          mcpFailureReply(
            failureAction,
            boundaryError("unavailable", "unknown", "MCP command did not complete."),
          ),
      )
      .then((output) => {
        if (!current() || invokeHostCallback(() => signal.signal?.aborted === true, true)) return;
        if (output.action === "view") return;
        const bounded = boundedMcpReply(output);
        const text =
          ctx.mode === "tui" && !settings && args.trim() !== "status"
            ? readableMcpOutcome(bounded)
            : JSON.stringify(bounded);
        if (invokeHostCallback(() => ctx.hasUI, false))
          notifyAtHostBoundary(ctx, text, bounded.isError ? "warning" : "info");
        else
          invokeHostCallback(
            () => pi.sendMessage({ customType: "pi-mcp.command", content: text, display: true }),
            undefined,
          );
      });
  };

/** Static command syntax only; completion never reads configuration or suggests JSON values. */
export const mcpSettingsCompletions = (prefix: string) => {
  if (prefix.length > 256) return null;
  const match = /^(set-server|remove-server|set-settings)\s+(\S*)$/.exec(prefix);
  const candidates = match
    ? ["global", "project"]
        .filter((scope) => scope.startsWith(match[2]!))
        .map((scope) => `${match[1]} ${scope}`)
    : ["show", "reload", "set-server", "remove-server", "set-settings"].filter((action) =>
        action.startsWith(prefix),
      );
  return candidates.length ? candidates.map((value) => ({ value, label: value })) : null;
};

export const registerMcpCommands = (pi: ExtensionAPI, port: McpCommandPort): void => {
  pi.registerCommand("mcp", {
    description:
      "MCP dashboard | status | browse [ID] | result ID | connect ID | disconnect ID | refresh ID | auth ID [--manual] | logout ID",
    getArgumentCompletions: (prefix) => mcpCompletions(prefix, port.serverIds()),
    handler: commandHandler(pi, port, false),
  });
  pi.registerCommand("mcp-settings", {
    description:
      "MCP settings: show | reload | set-server SCOPE ID JSON | remove-server SCOPE ID | set-settings SCOPE JSON",
    getArgumentCompletions: mcpSettingsCompletions,
    handler: commandHandler(pi, port, true),
  });
};
