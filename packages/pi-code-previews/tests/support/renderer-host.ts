import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { extensionApiFixture } from "pi-cosmic-core/testing";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../../src/application/tool-renderers";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import type { CodePreviewToolName } from "../../src/tools/names";
import { isNativeMcpName } from "../../src/tools/native-mcp-identity";

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
  parameters: {},
  exposure: "direct",
  sourceInfo: { source: "builtin", path, scope: "temporary", origin: "top-level" },
});

export const inertScheduler = { defer: () => () => undefined, schedule: () => () => undefined };

export function presentationResolver<Host extends object>(
  host: Host,
  enabled?: Iterable<CodePreviewToolName>,
) {
  const pi = extensionApiFixture({ getCommands: () => [], ...host });
  const owner = new CodePreviewPresentationOwner();
  if (enabled) owner.publish("/project", new Set(enabled), inertScheduler);
  return { pi, owner, resolver: createCodePreviewRendererResolver(pi, () => owner, new Set()) };
}

export const setPlainPreviewSettings = (overrides: Partial<CodePreviewSettings>) =>
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallTiming: false,
    ...overrides,
  });
