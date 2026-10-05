import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import type {
  CodePreviewRendererAppearance,
  PreviewToolInfo,
} from "../application/renderer-contract";
import { webAccessAdapter } from "./web-access/render";

/** Presentation-only adapters. No execution definitions, discovery I/O, or activation hooks. */
export interface ThirdPartyAdapter {
  readonly names: readonly string[];
  admits(tool: PreviewToolInfo): boolean;
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
export function thirdPartyAdapter(name: string, tool: PreviewToolInfo | undefined) {
  if (!tool || tool.name !== name) return undefined;
  const matches = adapters.filter(
    (adapter) => adapter.names.includes(name) && adapter.admits(tool),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
