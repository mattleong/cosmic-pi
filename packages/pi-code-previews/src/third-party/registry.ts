import * as Arr from "effect/Array";
import type { ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { CodePreviewRendererAppearance } from "../application/renderer-contract";
import { webAccessAdapter } from "./web-access/render";

export interface ThirdPartyAdapter {
  readonly names: readonly string[];
  admits(tool: ToolInfo): boolean;
  create(
    name: string,
    downstream: ToolRenderers | undefined,
    appearance: CodePreviewRendererAppearance,
  ): ToolRenderers | undefined;
}

const adapters: readonly ThirdPartyAdapter[] = [webAccessAdapter];

export function isThirdPartyPreviewName(name: string): boolean {
  return Arr.some(adapters, (adapter) => adapter.names.includes(name));
}

export function thirdPartyAdapter(name: string, tool: ToolInfo | undefined) {
  if (!tool || tool.name !== name) return undefined;
  const matches = Arr.filter(
    adapters,
    (adapter) => adapter.names.includes(name) && adapter.admits(tool),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
