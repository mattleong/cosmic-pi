// Public renderer-host fixtures: builtin metadata and factory resolvers.
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { extensionApiFixture, opaqueFixture } from "pi-cosmic-core/testing";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../../src/application/tool-renderers";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import type { CodePreviewToolName } from "../../src/tools/names";
import { isNativeMcpName } from "../../src/tools/native-mcp-identity";

/** Exact public builtin metadata; tool search and native MCP names default to Pi's own paths. */
export const builtinToolInfo = (
  name: string,
  path = isNativeMcpName(name)
    ? "builtin:mcp"
    : name === "tool_search"
      ? "builtin:tool-search"
      : `builtin:${name}`,
): ToolInfo => ({
  name,
  description: name,
  parameters: opaqueFixture({}),
  exposure: "direct",
  sourceInfo: { source: "builtin", path, scope: "temporary", origin: "top-level" },
});

/** A scheduler that never runs deferred or animated work. */
export const inertScheduler = { defer: () => () => undefined, schedule: () => () => undefined };

/** The factory-time resolver over `host` metadata, owned by one presentation owner. */
export function presentationResolver<Host extends object>(
  host: Host,
  /** Publishes the owner with this preview selection; omitted, the owner is still starting. */
  enabled?: Iterable<CodePreviewToolName>,
) {
  const pi = extensionApiFixture({ getCommands: () => [], ...host });
  const owner = new CodePreviewPresentationOwner();
  if (enabled) owner.publish("/project", new Set(enabled), inertScheduler);
  return { pi, owner, resolver: createCodePreviewRendererResolver(pi, () => owner, new Set()) };
}

/** Defaults without syntax colors or timing, plus `overrides`. */
export const setPlainPreviewSettings = (overrides: Partial<CodePreviewSettings>) =>
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallTiming: false,
    ...overrides,
  });
