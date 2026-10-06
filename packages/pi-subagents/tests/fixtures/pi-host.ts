import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionHandler,
  ExtensionUIContext,
  SourceInfo,
  Theme,
  ToolDefinition,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { extensionApiFixture as hostApiFixture, opaqueFixture } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";

/** Core's host fixture with a no-op `registerMessageRenderer`, which extension setup calls. */
export const extensionApiFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionAPI =>
  hostApiFixture({ registerMessageRenderer: () => undefined, ...fixture });

/**
 * Pi's registry as one loaded extension sees it: every tool and command it registers carries its
 * one source, registration activates a tool unless it declares `defaultActive: false`, and
 * renderer resolution passes the registered definition, if any, as `next()`.
 */
export const sourcedExtensionHost = (
  sourceInfo: SourceInfo = {
    source: "local",
    path: "/extensions/pi-subagents/index.ts",
    scope: "user",
    origin: "top-level",
  },
) => {
  const handlers = new Map<string, ExtensionHandler<any, any>>();
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const commands: ReturnType<ExtensionAPI["getCommands"]> = [];
  const resolvers: ToolRendererResolver[] = [];
  let active: ReadonlyArray<string> = ["read"];
  let rejectTools = false;
  const pi = extensionApiFixture({
    on: (name: string, handler: ExtensionHandler<any, any>) => {
      handlers.set(name, handler);
    },
    registerCommand: (name: string, command: { readonly description?: string }) => {
      commands.push({
        name,
        ...(command.description !== undefined && { description: command.description }),
        source: "extension",
        sourceInfo,
      });
    },
    registerToolRenderer: (resolver: ToolRendererResolver) => {
      resolvers.push(resolver);
    },
    registerTool: (tool: ToolDefinition<any, any, any>) => {
      if (rejectTools) throw new Error("stale extension handle");
      const fresh = !tools.has(tool.name) && tool.defaultActive !== false;
      tools.set(tool.name, tool);
      if (fresh) active = [...active, tool.name];
    },
    getAllTools: () =>
      [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        sourceInfo,
      })),
    getCommands: () => [...commands],
    getActiveTools: () => [...active],
    setActiveTools: (names: ReadonlyArray<string>) => {
      active = names.filter((name) => name === "read" || tools.has(name));
    },
    sendMessage: () => undefined,
  });
  const resolve = (name: string): ToolRenderers | undefined => {
    const next = (index: number): ToolRenderers | undefined =>
      index < resolvers.length ? resolvers[index]!(name, () => next(index + 1)) : tools.get(name);
    return next(0);
  };
  return {
    pi,
    handlers,
    tools,
    resolve,
    active: () => [...active],
    rejectTools: (reject: boolean) => {
      rejectTools = reject;
    },
  };
};

export const modelFixture = <Fixture extends object>(fixture: Fixture): Fixture & Model<Api> => {
  // SAFETY: Each test invokes only the model members explicitly implemented by its fixture.
  return fixture as Fixture & Model<Api>;
};

/** Pi's custom UI over the shared pinned-Pi fake: select keys confirm and cancel, and each
 * component mounts one microtask after its factory, as pinned Pi does. */
export const mountingCustomUi = (
  theme: Theme,
  created: (component: Component) => void,
  size: { readonly columns?: number; readonly rows?: number } = {},
) => {
  const host = fakeCustomSurfaceHost({
    ...size,
    theme,
    keybindings: opaqueFixture({
      matches: (data: string, id: string) =>
        id === "tui.select.confirm"
          ? matchesKey(data, Key.enter)
          : id === "tui.select.cancel"
            ? matchesKey(data, Key.escape)
            : false,
      getKeys: () => [],
    }),
  });
  const custom: ExtensionUIContext["custom"] = (factory, options) => {
    const opened = host.ctx.ui.custom((...args: Parameters<typeof factory>) => {
      const component = factory(...args);
      if (!Predicate.isPromiseLike(component)) created(component);
      return component;
    }, options);
    queueMicrotask(host.mount);
    return opened;
  };
  return { host, custom };
};
