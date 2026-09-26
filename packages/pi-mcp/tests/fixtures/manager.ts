import { plainTheme } from "pi-cosmic-core/testing";
import type { McpManagerServer, McpManagerSnapshot } from "../../src/manager/model.ts";
import { McpManagerComponent, type McpViewRequest } from "../../src/ui/manager.ts";
import {
  managerSelection,
  type McpManagerClose,
  type McpManagerSelection,
} from "../../src/ui/manager-state.ts";

export const managerRow = (
  overrides: Partial<Omit<McpManagerServer, "actions">> = {},
): Omit<McpManagerServer, "actions"> => ({
  id: "a",
  scope: "global",
  transport: "stdio",
  enabled: true,
  invalid: false,
  diagnostic: undefined,
  authType: "none",
  auth: "none",
  state: "disconnected",
  blockedReason: undefined,
  active: 0,
  queued: 0,
  operations: 0,
  metadata: undefined,
  metadataState: "undiscovered",
  configRevision: 1,
  operationRevision: 0,
  ...overrides,
});

/** The pure manager component, recording its reads and closes instead of performing them. */
export const managerHarness = (
  snapshot: () => McpManagerSnapshot,
  options: {
    readonly screen?: McpManagerSelection["screen"];
    readonly resultId?: string | undefined;
    readonly height?: number;
    readonly collideWithMode?: boolean;
  } = {},
) => {
  const requests: McpViewRequest[] = [];
  const finishes: Array<McpManagerClose | undefined> = [];
  const component = new McpManagerComponent({
    theme: plainTheme,
    snapshot,
    selection: managerSelection(options.screen, undefined, options.resultId),
    height: () => options.height ?? 28,
    requestRender() {},
    load: (request) => void requests.push(request),
    finish: (close) => void finishes.push(close),
    matchesKeybinding: (data) => options.collideWithMode === true && data === "v",
    keybindingLabel: (_id, fallback) => (options.collideWithMode ? "v" : fallback),
  });
  return { component, requests, finishes };
};

const isKind = <K extends McpViewRequest["kind"]>(
  request: McpViewRequest | undefined,
  kind: K,
): request is Extract<McpViewRequest, { readonly kind: K }> => request?.kind === kind;

/** The request at `index`, failing the test unless it has the expected kind. */
export const requestOf = <K extends McpViewRequest["kind"]>(
  requests: ReadonlyArray<McpViewRequest>,
  kind: K,
  index = -1,
) => {
  const request = requests.at(index);
  if (!isKind(request, kind)) throw new Error("fixture");
  return request;
};
