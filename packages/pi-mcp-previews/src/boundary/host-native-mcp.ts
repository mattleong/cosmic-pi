import * as Pi from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionFactory,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";

export type NativeMcpCommand = Omit<RegisteredCommand, "name" | "sourceInfo">;
export type NativeMcpDefinition = ToolDefinition<any, any, any>;
type HostOn = <Event, Context, Result>(
  event: string,
  handler: (event: Event, ctx: Context) => Result,
) => () => void;

/** Ownership policy applied to every native registration; supplied by the registration owner. */
export interface NativeMcpGate {
  readonly event: <Event, Context, Result>(
    name: string,
    handler: (event: Event, ctx: Context) => Result,
  ) => (event: Event, ctx: Context) => Result | undefined;
  readonly command: (command: NativeMcpCommand) => NativeMcpCommand;
  /** Receives each fresh native definition at callback time; returns what the owner registers. */
  readonly tool: (definition: NativeMcpDefinition) => NativeMcpDefinition;
}

/**
 * Pi's public native MCP factory with its production defaults. Namespace lookup keeps older Pi
 * peers without this optional factory loadable.
 */
export function nativeMcpFactory(): ExtensionFactory | undefined {
  return Predicate.isFunction(Pi.createMcpExtension) ? Pi.createMcpExtension() : undefined;
}

/**
 * Compose one fresh native MCP factory with this extension's owning API. While the factory runs,
 * event handlers and the one `/mcp` command are buffered and every other eager registration is
 * rejected. Failures before commit register nothing. Host commit calls may mutate then throw;
 * there is no rollback guarantee, and the owning gates remain closed on failure. On success the
 * buffer commits through the gate. Afterwards native callbacks use the owner's live
 * API unchanged, except that fresh tool definitions pass through the gate first. This never
 * retrieves, wraps, or mutates a definition registered by the builtin or another extension.
 */
export function composeNativeMcp(
  pi: ExtensionAPI,
  factory: ExtensionFactory,
  gate: NativeMcpGate,
): Promise<boolean> {
  let phase: "composing" | "live" | "failed" = "composing";
  let rejected = false;
  let manager: NativeMcpCommand | undefined;
  const events: Array<() => void> = [];
  const refuse = (registration: string): never => {
    rejected = true;
    throw new Error(`Native MCP composition does not admit ${registration}`);
  };
  const admitLive = (registration: string): void => {
    if (phase !== "live") refuse(registration);
  };
  const guarded =
    <Args extends ReadonlyArray<unknown>, Result>(
      registration: string,
      forward: (...args: Args) => Result,
    ) =>
    (...args: Args): Result => {
      admitLive(registration);
      return forward(...args);
    };
  const hostOn: HostOn = (name, handler) =>
    // SAFETY: Pi's `on` overloads share one implementation keyed by event name; gated handlers
    // receive the host's own event and context arguments and return the native result unchanged.
    (pi.on as HostOn)(name, handler);
  const on: HostOn = (name, handler) => {
    const gated = gate.event(name, handler);
    if (phase === "live") return hostOn(name, gated);
    if (phase === "failed") return refuse(`the ${name} handler`);
    let removed = false;
    let unsubscribe: (() => void) | undefined;
    events.push(() => {
      if (!removed) unsubscribe = hostOn(name, gated);
    });
    return () => {
      removed = true;
      unsubscribe?.();
    };
  };
  // Built inside the composition guard: a host lacking a guarded method fails closed.
  const ownerApi = (): ExtensionAPI => ({
    ...pi,
    on,
    registerCommand(name, options) {
      if (phase === "live") return pi.registerCommand(name, gate.command(options));
      if (phase === "failed" || name !== "mcp" || manager) return refuse(`the /${name} command`);
      manager = options;
    },
    registerTool(definition) {
      admitLive("a tool");
      pi.registerTool(gate.tool(definition));
    },
    registerShortcut: guarded("a shortcut", pi.registerShortcut.bind(pi)),
    registerFlag: guarded("a flag", pi.registerFlag.bind(pi)),
    registerMessageRenderer: guarded("a message renderer", pi.registerMessageRenderer.bind(pi)),
    registerMarkdownTransformer: guarded(
      "a markdown transformer",
      pi.registerMarkdownTransformer.bind(pi),
    ),
    registerEntryRenderer: guarded("an entry renderer", pi.registerEntryRenderer.bind(pi)),
    // SAFETY: The guard forwards the caller's original argument list to the same overloaded method.
    registerProvider: guarded(
      "a provider",
      pi.registerProvider.bind(pi),
    ) as ExtensionAPI["registerProvider"],
    unregisterProvider: guarded("a provider removal", pi.unregisterProvider.bind(pi)),
    registerMcpServer: guarded("an MCP server", pi.registerMcpServer.bind(pi)),
    unregisterMcpServer: guarded("an MCP server removal", pi.unregisterMcpServer.bind(pi)),
    registerVirtualModel: guarded("a virtual model", pi.registerVirtualModel.bind(pi)),
    unregisterVirtualModel: guarded("a virtual model removal", pi.unregisterVirtualModel.bind(pi)),
    events: {
      emit: (channel, data) => {
        admitLive("an event-bus message");
        pi.events.emit(channel, data);
      },
      on: (channel, handler) => {
        admitLive("an event-bus listener");
        return pi.events.on(channel, handler);
      },
    },
  });

  const fail = (): false => {
    phase = "failed";
    return false;
  };
  const commit = (): boolean => {
    if (rejected || !manager) return fail();
    try {
      // Public host registration may mutate then throw, including registerCommand. No rollback
      // is possible; phase and the owner's composition gate stay closed after failed commit.
      for (const register of events) register();
      pi.registerCommand("mcp", gate.command(manager));
    } catch {
      return fail();
    }
    phase = "live";
    return true;
  };
  // Invoked synchronously like Pi's loader; an asynchronous factory commits once it settles.
  let loading: void | Promise<void>;
  try {
    loading = factory(ownerApi());
  } catch {
    return Promise.resolve(fail());
  }
  return Promise.resolve(loading).then(commit, fail);
}
