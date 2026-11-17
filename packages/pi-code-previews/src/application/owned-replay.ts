import { defineTool, type ExtensionAPI, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { capturePreviewHostTools } from "../boundary/host-tool-renderers";
import { withCodePreviewShell } from "../tools/cooperative-tools";
import { isSameExtensionSource } from "../tools/preview-admission";
import { answerToolRendererLookups } from "./renderer-lookup";
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
  // The live rows' renderers, which a surface drawing another conversation's calls looks up.
  const stagedLive = new Map<string, ToolRenderers>();
  const live = new Map<string, ToolRenderers>();
  const gate = new RetainedRendererGate();
  answerToolRendererLookups(pi.events, (name) =>
    gate.live && gate.ready ? live.get(name) : undefined,
  );
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
      const liveRenderers = rendererFields(defineTool(wrapped));
      if (liveRenderers) stagedLive.set(tool.name, liveRenderers);
    }
    return wrapped;
  };
  const retire = () => {
    gate.retire();
    staged.clear();
    selected.clear();
    stagedLive.clear();
    live.clear();
  };
  return {
    shell,
    publish: () => {
      if (!gate.live || gate.ready) return;
      const host = invokeHostCallback(
        () => capturePreviewHostTools(pi, options.command),
        undefined,
      );
      const owns = (name: string) =>
        host !== undefined && isSameExtensionSource(host.tools.get(name), host.previewSource);
      for (const [name, renderers] of staged) if (owns(name)) selected.set(name, renderers);
      for (const [name, renderers] of stagedLive) if (owns(name)) live.set(name, renderers);
      staged.clear();
      stagedLive.clear();
      gate.markReady();
    },
    finishStartup: () => {
      if (!gate.ready) retire();
    },
    retire,
  };
}
