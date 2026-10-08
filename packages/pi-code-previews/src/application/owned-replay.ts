import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import * as Predicate from "effect/Predicate";
import { capturePreviewHostTools } from "../boundary/host-tool-renderers";
import { withCodePreviewShell } from "../tools/cooperative-tools";
import { isSameExtensionSource } from "../tools/preview-admission";
import { rendererFields, RetainedRendererGate, retainedCodePreviewRenderers } from "./renderer-row";

export interface CodePreviewReplayOptions {
  /** Unique extension command registered by this same factory, used as the ownership anchor. */
  readonly command: string;
  /** Only this extension's executable tool names. This does not register or activate them. */
  readonly tools: readonly string[];
}

export interface CodePreviewReplay {
  /** Wrap after trusted settings load; stage a fixed-self-shell variant for cold history. */
  readonly shell: typeof withCodePreviewShell;
  /** Publish once, after all eligible tools have been successfully registered. */
  readonly publish: () => void;
  /** Close failed/aborted startup without retiring a successfully published first owner. */
  readonly finishStartup: () => void;
  /** Revoke pending adoption on shutdown/replacement; already adopted rows keep their content. */
  readonly retire: () => void;
}

/**
 * Factory-time, renderer-only bridge for tools registered during session_start. Pi reconstructs
 * history before that event and fixes each row's renderers and outer shell at construction.
 * No execution definition, activation, settings I/O, or scheduler is owned by this bridge.
 */
export function registerCodePreviewReplay(
  pi: ExtensionAPI,
  options: CodePreviewReplayOptions,
): CodePreviewReplay {
  const names = new Set(options.tools);
  const staged = new Map<string, ToolRenderers>();
  const selected = new Map<string, ToolRenderers>();
  const gate = new RetainedRendererGate();
  if (Predicate.isFunction(pi.registerToolRenderer))
    pi.registerToolRenderer((name, next) => {
      const downstream = rendererFields(next());
      if (!gate.live || gate.ready || !names.has(name) || downstream) return downstream;
      // Before registration this preserves raw evidence only, not an unverified tool identity.
      return retainedCodePreviewRenderers(name, undefined, gate, () => selected.get(name));
    });
  else gate.retire();

  const shell: typeof withCodePreviewShell = (tool, shellOptions = {}) => {
    const wrapped = withCodePreviewShell(tool, shellOptions);
    if (gate.live && !gate.ready && names.has(tool.name)) {
      const replay = withCodePreviewShell(tool, { ...shellOptions, selfShell: true });
      // SAFETY: The anchored tool name preserves the specialized args/details/state correlation.
      // Only public renderer fields survive; no execution definition is retained.
      const renderers = rendererFields(replay as ToolRenderers);
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
