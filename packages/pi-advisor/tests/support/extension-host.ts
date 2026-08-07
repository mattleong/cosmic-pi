// Test harness boundary: Pi callbacks are Promise-shaped by contract.
// @effect-diagnostics effect/asyncFunction:off
import type {
  ExtensionAPI,
  ExtensionContext,
  ResolvedCommand,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export type HostHandler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>;

/**
 * Captures Pi event registrations and replays them either serially awaited or
 * detached with swallowed rejections, exactly like the live turn_end host.
 */
export function handlerRegistry() {
  const handlers = new Map<string, HostHandler[]>();
  const on = (name: string, handler: HostHandler) =>
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  const emitWithContext = async (name: string, event: unknown, context: ExtensionContext) => {
    for (const handler of handlers.get(name) ?? []) await handler(event as never, context);
  };
  const emitDetachedWithContext = (name: string, event: unknown, context: ExtensionContext) => {
    for (const handler of handlers.get(name) ?? []) {
      Promise.resolve(handler(event as never, context)).catch(() => undefined);
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
export function anchorUserBranch(): Array<Record<string, unknown>> {
  return [
    {
      id: "anchor",
      type: "message",
      parentId: null,
      timestamp: "now",
      message: { role: "user", content: "request" },
    },
  ];
}

export interface AdvisorExtensionApiOptions {
  on: (name: string, handler: HostHandler) => void;
  registerCommand: (name: string, command: never) => void;
  appendEntry?: ((customType: string, data: unknown) => void) | undefined;
  sendMessage?: ((...args: never[]) => unknown) | undefined;
}

/** Composes an ExtensionAPI double from the harness's own capture pieces. */
export function advisorExtensionApi(options: AdvisorExtensionApiOptions): ExtensionAPI {
  return {
    on: options.on,
    registerCommand: options.registerCommand,
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendMessage: options.sendMessage ?? vi.fn(),
    appendEntry: vi.fn(options.appendEntry ?? (() => undefined)),
  } as unknown as ExtensionAPI;
}

export interface AdvisorExtensionContextOptions {
  getBranch: () => Array<Record<string, unknown>>;
  isProjectTrusted?: boolean | undefined;
  modelRegistry?: Record<string, unknown> | undefined;
  select?: ((...args: never[]) => unknown) | undefined;
  withoutSessionId?: boolean | undefined;
}

/** Composes the shared ExtensionContext double with call-site override slots. */
export function advisorExtensionContext(options: AdvisorExtensionContextOptions): ExtensionContext {
  const trusted = options.isProjectTrusted ?? true;
  return {
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
    sessionManager: {
      buildContextEntries: vi.fn(() => []),
      getBranch: vi.fn(options.getBranch),
      getLeafId: vi.fn(() => "anchor"),
      ...(options.withoutSessionId ? {} : { getSessionId: vi.fn(() => "session") }),
    },
  } as unknown as ExtensionContext;
}
