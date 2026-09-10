import type { Theme } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { mcpCompletions } from "../../src/manager/controller.ts";
import type { McpManagerServer, McpManagerSnapshot } from "../../src/manager/model.ts";
import { serverActions } from "../../src/manager/policy.ts";
import { McpManagerComponent, type McpViewRequest } from "../../src/ui/manager.ts";
import { browserCatalogStatus } from "../../src/ui/browser.ts";
import { managerSelection, type McpManagerClose } from "../../src/ui/manager-state.ts";
import type { McpCachedEntry, McpCachedPage } from "../../src/discovery/model.ts";

// SAFETY: The pure component uses only fg and bold from this controlled theme.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const base: Omit<McpManagerServer, "actions"> = {
  id: "a",
  scope: "global",
  transport: "stdio",
  enabled: true,
  invalid: false,
  authType: "none",
  auth: "none",
  state: "disconnected",
  blockedReason: undefined,
  active: 0,
  queued: 0,
  operations: 0,
  metadata: undefined,
  configRevision: 1,
  operationRevision: 0,
};
const snapshot: McpManagerSnapshot = {
  revision: 1,
  trusted: true,
  enabled: true,
  active: 0,
  queued: 0,
  servers: [{ ...base, actions: serverActions(base, true, true) }],
};
const entry = (name: string): McpCachedEntry => ({
  name,
  description: name,
  ref: { server: "a", family: "tools", id: name, owner: "owner", revision: 1, configRevision: 1 },
});
const page = (name: string): McpCachedPage => ({
  family: "tools",
  entries: [entry(name)],
  catalogs: [{ server: "a", state: "ready", count: 1, revision: 1 }],
  total: 1,
  next: undefined,
});
const harness = (screen: "dashboard" | "browse" | "result" = "dashboard") => {
  let current = snapshot;
  const requests: McpViewRequest[] = [];
  const finishes: Array<McpManagerClose | undefined> = [];
  const component = new McpManagerComponent({
    theme,
    snapshot: () => current,
    selection: managerSelection(screen, undefined, screen === "result" ? "retained-id" : undefined),
    height: () => 28,
    requestRender() {},
    load: (request) => {
      requests.push(request);
    },
    finish: (close) => {
      finishes.push(close);
    },
    matchesKeybinding: () => false,
    keybindingLabel: (_id, fallback) => fallback,
  });
  return {
    component,
    requests,
    finishes,
    replace: (next: McpManagerSnapshot) => {
      current = next;
      component.update();
    },
  };
};
it("dashboard opening/repaint/Enter remain passive and search keeps ordinary text input", () => {
  const h = harness();
  h.component.render(60);
  h.component.render(160);
  h.component.handleInput("\r");
  expect(h.requests).toEqual([]);
  expect(h.finishes).toEqual([]);
  h.component.handleInput("b");
  const request = h.requests.at(-1)!;
  expect(request.kind).toBe("cached");
  h.component.handleInput("/");
  h.component.focused = true;
  h.component.handleInput("a");
  expect(h.requests.at(-1)).toMatchObject({ kind: "cached", request: { query: "a" } });
  h.component.handleInput("工具");
  h.component.handleInput("qj/?");
  expect(h.requests.at(-1)).toMatchObject({ kind: "cached", request: { query: "a工具qj/?" } });
  expect(h.finishes).toEqual([]);
});
it("late cached search/detail replies cannot republish withdrawn or replaced content", () => {
  const h = harness("browse");
  const old = h.requests[0]!;
  h.component.handleInput("/");
  h.component.handleInput("n");
  const fresh = h.requests.at(-1)!;
  if (fresh.kind !== "cached" || old.kind !== "cached") throw new Error("fixture");
  fresh.deliver(page("current-entry"));
  old.deliver(page("revoked-secret"));
  expect(h.component.render(160).join("\n")).not.toContain("revoked-secret");
  h.component.handleInput("\u001b");
  h.component.handleInput("\r");
  const detail = h.requests.at(-1)!;
  expect(detail.kind).toBe("detail");
  h.component.update();
  expect(h.component.render(160).join("\n")).not.toContain("current-entry");
  if (detail.kind === "detail")
    detail.deliver({
      ref: entry("current-entry").ref,
      name: "current-entry",
      description: "late-secret",
      metadata: "late-secret",
      truncated: false,
    });
  expect(h.component.render(160).join("\n")).not.toContain("late-secret");
  h.component.dispose();
  fresh.deliver(page("after-close-secret"));
  expect(h.component.render(160)).toEqual([]);
});
it("changing selection rejects an old detail delivery without retargeting it", () => {
  const h = harness("browse");
  const cached = h.requests[0]!;
  if (cached.kind !== "cached") throw new Error("fixture");
  cached.deliver({
    ...page("first-entry"),
    entries: [entry("first-entry"), entry("second-entry")],
    total: 2,
  });
  h.component.render(160);
  h.component.handleInput("\r");
  const oldDetail = h.requests.at(-1)!;
  if (oldDetail.kind !== "detail") throw new Error("fixture");
  h.component.handleInput("h");
  h.component.handleInput("j");
  oldDetail.deliver({
    ref: entry("first-entry").ref,
    name: "first-entry",
    description: "first-only-secret",
    metadata: "first-only-secret",
    truncated: false,
  });
  expect(h.component.render(160).join("\n")).not.toContain("first-only-secret");
  h.component.handleInput("\r");
  expect(h.requests.at(-1)).toMatchObject({ kind: "detail", ref: { id: "second-entry" } });
});
it.each(["refreshing", "refresh-failed"] as const)(
  "keeps %s visible alongside a nonempty catalog",
  (state) => {
    const h = harness("browse");
    const request = h.requests[0]!;
    if (request.kind !== "cached") throw new Error("fixture");
    const catalog = { server: "a", state, count: 1, revision: 1 };
    request.deliver({ ...page("retained-entry"), catalogs: [catalog] });
    for (const width of [90, 160]) {
      const text = h.component.render(width).join("\n");
      expect(text).toContain("retained-entry");
      expect(text).toContain(browserCatalogStatus(catalog));
    }
  },
);
it("reauthorizes expanded metadata after invalidation without losing its viewport", () => {
  const h = harness("browse");
  const request = h.requests[0]!;
  if (request.kind !== "cached") throw new Error("fixture");
  const cached = page("retained-entry");
  request.deliver(cached);
  h.component.render(160);
  h.component.handleInput("\r");
  const initial = h.requests.at(-1)!;
  if (initial.kind !== "detail") throw new Error("fixture");
  const detail = {
    ...entry("retained-entry"),
    metadata: Array.from({ length: 100 }, (_, index) => `expanded-line-${index}-end`).join("\n"),
    truncated: false,
  };
  initial.deliver(detail);
  h.component.render(160);
  h.component.handleInput("G");
  expect(h.component.render(160).join("\n")).toContain("expanded-line-99-end");
  h.component.update();
  expect(h.component.render(160).join("\n")).not.toContain("expanded-line-");
  const reread = h.requests.at(-1)!;
  if (reread.kind !== "cached") throw new Error("fixture");
  reread.deliver(cached);
  expect(h.component.render(160).join("\n")).not.toContain("expanded-line-");
  const authorized = h.requests.at(-1)!;
  if (authorized.kind !== "detail") throw new Error("fixture");
  authorized.deliver(detail);
  const restored = h.component.render(160).join("\n");
  expect(restored).toContain("expanded-line-99-end");
  expect(restored).not.toContain("expanded-line-0-end");
});
it("an open action menu returns its displayed row rather than a replacement snapshot", () => {
  const h = harness();
  h.component.handleInput("a");
  const replacement = { ...snapshot.servers[0]!, configRevision: 2 };
  h.replace({ ...snapshot, revision: 2, servers: [replacement] });
  h.component.handleInput("j");
  h.component.handleInput("j");
  h.component.handleInput("j");
  h.component.handleInput("\r");
  expect(h.finishes[0]?.action).toBe("connect");
  expect(h.finishes[0]?.row).toBe(snapshot.servers[0]);
  expect(h.finishes[0]?.row).not.toBe(replacement);
});
it("empty all-server browsing can select a server before explicit discovery", () => {
  const h = harness("browse");
  const cached = h.requests[0]!;
  if (cached.kind !== "cached") throw new Error("fixture");
  cached.deliver({
    ...page("unused"),
    entries: [],
    total: 0,
    catalogs: [{ server: "a", state: "undiscovered", count: 0, revision: 0 }],
  });
  h.component.handleInput("s");
  h.component.handleInput("j");
  h.component.handleInput("\r");
  expect(h.requests.at(-1)).toMatchObject({ kind: "cached", request: { server: "a" } });
  h.component.handleInput("a");
  for (let index = 0; index < 4; index += 1) h.component.handleInput("j");
  h.component.handleInput("\r");
  expect(h.finishes[0]).toMatchObject({ action: "refresh", row: { id: "a" } });
});
it("retained-result navigation uses returned offsets and an unavailable ID never requests source execution", () => {
  const h = harness("result");
  const first = h.requests[0]!;
  if (first.kind !== "result") throw new Error("fixture");
  first.deliver({ offset: 0, next: 7, total: 30, lines: ["a🙂data"] });
  h.component.render(50);
  h.component.render(150);
  expect(h.requests).toHaveLength(1);
  h.component.handleInput("n");
  expect(h.requests.at(-1)).toMatchObject({ kind: "result", id: "retained-id", offset: 7 });
  const second = h.requests.at(-1)!;
  if (second.kind !== "result") throw new Error("fixture");
  second.deliver(undefined);
  h.component.handleInput("n");
  h.component.handleInput("p");
  expect(h.requests).toHaveLength(2);
});
it("result movements scroll the loaded page without moving a hidden server selection", () => {
  const h = harness("result");
  const request = h.requests[0]!;
  if (request.kind !== "result") throw new Error("fixture");
  const loaded = {
    offset: 0,
    next: undefined,
    total: 1000,
    lines: Array.from({ length: 100 }, (_, index) => `result-line-${index}-end`),
  };
  request.deliver(loaded);
  expect(h.component.render(90).join("\n")).toContain("result-line-0-end");
  h.component.handleInput("j");
  expect(h.component.render(90).join("\n")).not.toContain("result-line-0-end");
  expect(h.requests).toHaveLength(1);
  h.component.update();
  expect(h.component.render(90).join("\n")).not.toContain("result-line-");
  const authorized = h.requests.at(-1)!;
  if (authorized.kind !== "result") throw new Error("fixture");
  authorized.deliver(loaded);
  expect(h.component.render(90).join("\n")).not.toContain("result-line-0-end");
  expect(h.component.render(90).join("\n")).toContain("result-line-1-end");
  h.component.handleInput("\u001b");
  expect(h.finishes).toHaveLength(1);
});
it("command completion uses exact configured IDs and does not invent result history", () => {
  expect(mcpCompletions("browse a", ["a", "another", "b"])?.map((item) => item.value)).toEqual([
    "browse a",
    "browse another",
  ]);
  expect(mcpCompletions("result ", ["a"])).toBeNull();
});
