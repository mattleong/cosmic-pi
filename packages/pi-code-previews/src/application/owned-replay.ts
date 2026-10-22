import { defineTool, type ExtensionAPI, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import { capturePreviewHostTools } from "../boundary/host-tool-renderers";
import { withCodePreviewShell } from "../tools/cooperative-tools";
import { isSameExtensionSource } from "../tools/preview-admission";
import { rendererFields, RetainedRendererGate, retainedCodePreviewRenderers } from "./renderer-row";

export interface CodePreviewReplayOptions {
  readonly command: string;
  readonly tools: readonly string[];
}

export interface CodePreviewReplay {
  readonly shell: typeof withCodePreviewShell;
  readonly publish: () => void;
  readonly finishStartup: () => void;
  readonly retire: () => void;
}

export function registerCodePreviewReplay(
  pi: ExtensionAPI,
  options: CodePreviewReplayOptions,
): CodePreviewReplay {
  const names = new Set(options.tools);
  const staged = new Map<string, ToolRenderers>();
  const selected = new Map<string, ToolRenderers>();
  const gate = new RetainedRendererGate();
  pi.registerToolRenderer((name, next) => {
    const downstream = rendererFields(next());
    if (!gate.live || gate.ready || !names.has(name) || downstream) return downstream;
    return retainedCodePreviewRenderers(name, undefined, gate, () => selected.get(name));
  });

  const shell: typeof withCodePreviewShell = (tool, shellOptions) => {
    const wrapped = withCodePreviewShell(tool, shellOptions);
    if (gate.live && !gate.ready && names.has(tool.name)) {
      const replay = withCodePreviewShell(tool, { ...shellOptions, selfShell: true });
      const renderers = rendererFields(defineTool(replay));
      if (renderers) staged.set(tool.name, renderers);
    }
    return wrapped;
  };
  const retire = () => {
    gate.retire();
    staged.clear();
    selected.clear();
  };
  return {
    shell,
    publish: () => {
      if (!gate.live || gate.ready) return;
      const host = invokeHostCallback(
        () => capturePreviewHostTools(pi, options.command),
        undefined,
      );
      for (const [name, renderers] of staged)
        if (host && isSameExtensionSource(host.tools.get(name), host.previewSource))
          selected.set(name, renderers);
      staged.clear();
      gate.markReady();
    },
    finishStartup: () => {
      if (!gate.ready) retire();
    },
    retire,
  };
}
