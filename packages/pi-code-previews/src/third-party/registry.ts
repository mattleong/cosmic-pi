import type { ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererAppearance } from "../application/renderer-contract";
import { webAccessAdapter } from "./web-access/render";

/** Presentation-only adapters. No execution definitions, discovery I/O, or activation hooks. */
export interface ThirdPartyAdapter {
  readonly names: readonly string[];
  admits(tool: ToolInfo): boolean;
  create(
    name: string,
    downstream: ToolRenderers | undefined,
    appearance: CodePreviewRendererAppearance,
  ): ToolRenderers | undefined;
}

/** Adding/removing an entry here is the only connection to a third-party package. */
const adapters: readonly ThirdPartyAdapter[] = [webAccessAdapter];

export function isThirdPartyPreviewName(name: string): boolean {
  return adapters.some((adapter) => adapter.names.includes(name));
}

/** Missing or duplicate public metadata never establishes external ownership, even in replay. */
export function thirdPartyAdapter(name: string, tool: ToolInfo | undefined) {
  if (!tool || tool.name !== name) return undefined;
  const matches = adapters.filter(
    (adapter) => adapter.names.includes(name) && adapter.admits(tool),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
