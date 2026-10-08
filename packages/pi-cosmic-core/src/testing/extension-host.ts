import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  RegisteredCommand,
  SourceInfo,
  ToolDefinition,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { extensionApiFixture } from "./host.ts";

type Handler = ExtensionHandler<any, any>;
type Tool = ToolDefinition<any, any, any>;
type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type MessageRenderer = Parameters<ExtensionAPI["registerMessageRenderer"]>[1];

interface RecordingExtensionHostOptions {
  /** The public source of every command and, unless `toolSource` is given, every tool. */
  readonly source?: SourceInfo;
  readonly toolSource?: SourceInfo;
}

const defaultSource: SourceInfo = {
  source: "local",
  path: "/extensions/test/index.ts",
  scope: "user",
  origin: "top-level",
};

/**
 * Pi's registry as one loaded extension sees it. It records every event handler, command, tool,
 * and renderer; reports the extension's public source; activates a newly registered tool unless
 * it declares `defaultActive: false`; ignores unknown names when tools are activated; and resolves
 * renderers through each registered resolver before the registered definition. `overrides`
 * replace the recording members they name.
 */
export const recordingExtensionHost = <Overrides extends object = object>(
  options: RecordingExtensionHostOptions = {},
  // SAFETY: An omitted argument infers Overrides as `object`, which the empty default satisfies.
  overrides: Overrides = {} as Overrides,
) => {
  const source = options.source ?? defaultSource;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const tools = new Map<string, Tool>();
  const registrations: Tool[] = [];
  const toolRenderers: ToolRendererResolver[] = [];
  const messageRenderers = new Map<string, MessageRenderer>();
  // Pi's builtin `read` is active before the extension registers its own tools.
  let active: ReadonlyArray<string> = ["read"];
  let rejectTools = false;
  const pi = extensionApiFixture({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: (name: string, command: Command) => {
      commands.set(name, command);
    },
    registerTool: (tool: Tool) => {
      if (rejectTools) throw new Error("stale extension handle");
      const fresh = !tools.has(tool.name) && tool.defaultActive !== false;
      tools.set(tool.name, tool);
      registrations.push(tool);
      if (fresh) active = [...active, tool.name];
    },
    registerToolRenderer: (resolver: ToolRendererResolver) => {
      toolRenderers.push(resolver);
    },
    registerMessageRenderer: (customType: string, render: MessageRenderer) => {
      messageRenderers.set(customType, render);
    },
    getAllTools: () =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: tool.exposure ?? "direct",
        sourceInfo: options.toolSource ?? source,
      })),
    getCommands: () =>
      [...commands].map(([name, command]) => ({
        name,
        ...(command.description !== undefined && { description: command.description }),
        source: "extension" as const,
        sourceInfo: source,
      })),
    getActiveTools: () => [...active],
    setActiveTools: (names: ReadonlyArray<string>) => {
      active = names.filter((name) => name === "read" || tools.has(name));
    },
    sendMessage: () => undefined,
    ...overrides,
  });
  /** Pi's resolver chain, ending at `base` or else the registered definition. */
  const resolve = (name: string, base?: ToolRenderers): ToolRenderers | undefined => {
    const next = (index: number): ToolRenderers | undefined =>
      index < toolRenderers.length
        ? toolRenderers[index]!(name, () => next(index + 1))
        : (base ?? tools.get(name));
    return next(0);
  };
  /**
   * Runs every handler of `name` in registration order, awaiting each, as Pi does. The first
   * handler runs synchronously; the event defaults to an empty object.
   */
  const emit = <Event>(name: string, ctx: ExtensionContext, event?: Event): Promise<void> => {
    const run = (index: number): Promise<void> => {
      const handler = handlers.get(name)?.[index];
      return handler === undefined
        ? Promise.resolve()
        : Promise.resolve(handler(event ?? {}, ctx)).then(() => run(index + 1));
    };
    return run(0);
  };
  return {
    pi,
    handlers,
    commands,
    tools,
    registrations,
    toolRenderers,
    messageRenderers,
    resolve,
    emit,
    active: () => [...active],
    rejectTools: (reject: boolean) => {
      rejectTools = reject;
    },
  };
};
