// Test harness boundary: Pi callbacks are Promise-shaped by contract.
// @effect-diagnostics effect/asyncFunction:off
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ResolvedCommand,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export type HostHandler = ExtensionHandler<any, any>;
export type AdvisorHostEntry = SessionEntry & {
  readonly customType?: string | undefined;
  readonly data?: unknown;
};

/**
 * Captures Pi event registrations and replays them either serially awaited or
 * detached with swallowed rejections, exactly like the live turn_end host.
 */
export function handlerRegistry() {
  const handlers = new Map<string, HostHandler[]>();
  const on = (name: string, handler: HostHandler) =>
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  const emitWithContext = async <Event>(name: string, event: Event, context: ExtensionContext) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, context);
  };
  const emitDetachedWithContext = <Event>(
    name: string,
    event: Event,
    context: ExtensionContext,
  ) => {
    for (const handler of handlers.get(name) ?? []) {
      Promise.resolve(handler(event, context)).catch(() => undefined);
    }
  };
  return { emitDetachedWithContext, emitWithContext, handlers, on };
}

/** Captures Pi command registrations for direct handler invocation. */
export function commandRegistry<Command = Omit<ResolvedCommand, "name" | "sourceInfo">>() {
  const commands = new Map<string, Command>();
  const registerCommand = (name: string, command: Command) => commands.set(name, command);
  return { commands, registerCommand };
}

/** A fresh instance-local mutable branch holding one genuine user anchor. */
export function anchorUserBranch(): AdvisorHostEntry[] {
  return [
    {
      id: "anchor",
      type: "message",
      parentId: null,
      timestamp: "now",
      message: { role: "user", content: "request", timestamp: 1 },
    },
  ];
}

export interface AdvisorExtensionApiOptions {
  on: (name: string, handler: HostHandler) => void;
  registerCommand: (name: string, command: never) => void;
  appendEntry?: ExtensionAPI["appendEntry"] | undefined;
  sendMessage?: ExtensionAPI["sendMessage"] | undefined;
}

/** Composes an ExtensionAPI double from the harness's own capture pieces. */
export function advisorExtensionApi(options: AdvisorExtensionApiOptions): ExtensionAPI {
  const fixture = {
    on: options.on,
    registerCommand: options.registerCommand,
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendMessage: options.sendMessage ?? vi.fn(),
    appendEntry: vi.fn(options.appendEntry ?? (() => undefined)),
  };
  // SAFETY: Advisor extension tests exercise only the ExtensionAPI methods implemented here.
  return fixture as typeof fixture & ExtensionAPI;
}

export interface AdvisorExtensionContextOptions {
  getBranch: () => AdvisorHostEntry[];
  isProjectTrusted?: boolean | undefined;
  modelRegistry?: Partial<ExtensionContext["modelRegistry"]> | undefined;
  select?: ExtensionContext["ui"]["select"] | undefined;
  withoutSessionId?: boolean | undefined;
}

/** Composes the shared ExtensionContext double with call-site override slots. */
export function advisorExtensionContext(options: AdvisorExtensionContextOptions): ExtensionContext {
  const trusted = options.isProjectTrusted ?? true;
  const fixture = {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn(() => false),
    isIdle: vi.fn(() => true),
    isProjectTrusted: vi.fn(() => trusted),
    ui: { notify: vi.fn(), setStatus: vi.fn(), select: options.select ?? vi.fn() },
    modelRegistry: options.modelRegistry ?? {
      getAvailable: vi.fn(() => []),
      find: vi.fn(),
      hasConfiguredAuth: vi.fn(),
    },
    sessionManager: (() => {
      const base = {
        buildContextEntries: vi.fn(() => []),
        getBranch: vi.fn(options.getBranch),
        getLeafId: vi.fn(() => "anchor"),
      };
      return options.withoutSessionId ? base : { ...base, getSessionId: vi.fn(() => "session") };
    })(),
  };
  // SAFETY: Advisor extension tests exercise only the ExtensionContext members implemented here.
  return fixture as typeof fixture & ExtensionContext;
}
