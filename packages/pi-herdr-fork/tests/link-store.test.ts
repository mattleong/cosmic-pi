import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeHostHerdrForkLinkStore } from "../src/boundary/host-link-store.ts";
import { HERDR_FORK_LINK_ENTRY_TYPE, type HerdrForkLink } from "../src/fork/link.ts";

const OWNER = {
  sessionId: "parent-session",
  sessionPath: "/sessions/parent.jsonl",
} as const;

const LINK: HerdrForkLink = {
  version: 1,
  parentSessionId: OWNER.sessionId,
  parentSessionPath: OWNER.sessionPath,
  childSessionId: "child-session",
  childSessionPath: "/sessions/child.jsonl",
  agentName: "fork-parent-p2",
  terminalId: "term-child",
};

interface CustomEntryFixture {
  readonly type: "custom";
  readonly customType: string;
  readonly data: HerdrForkLink;
}

const harness = (initialEntries: ReadonlyArray<CustomEntryFixture> = []) => {
  const entries = [...initialEntries];
  const appendEntry = vi.fn((customType: string, data: HerdrForkLink) => {
    entries.push({ type: "custom", customType, data });
  });
  const piFixture = { appendEntry };
  // SAFETY: The store uses only appendEntry, which this fixture implements.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const contextFixture = {
    sessionManager: { getEntries: () => entries },
  };
  // SAFETY: The store uses only sessionManager.getEntries, which this fixture implements.
  const ctx = contextFixture as typeof contextFixture & ExtensionContext;
  return {
    appendEntry,
    entries,
    store: makeHostHerdrForkLinkStore(pi, ctx, OWNER),
  };
};

describe("host reusable-link store", () => {
  it("records and restores the current parent session's link", () => {
    const h = harness();

    expect(h.store.restore()).toEqual({ _tag: "none" });
    expect(h.store.record(LINK)).toBe(true);
    expect(h.appendEntry).toHaveBeenCalledWith(HERDR_FORK_LINK_ENTRY_TYPE, LINK);
    expect(h.store.restore()).toEqual({ _tag: "restored", link: LINK });
  });

  it("ignores an inherited ancestor link", () => {
    const inherited: HerdrForkLink = {
      ...LINK,
      parentSessionId: "ancestor-session",
      parentSessionPath: "/sessions/ancestor.jsonl",
    };
    const h = harness([
      { type: "custom", customType: HERDR_FORK_LINK_ENTRY_TYPE, data: inherited },
    ]);

    expect(h.store.restore()).toEqual({ _tag: "none" });
  });

  it("fails closed when host reads or writes throw", () => {
    const appendEntry = vi.fn((_customType: string, _data: HerdrForkLink) => {
      throw new Error("append-secret");
    });
    const piFixture = { appendEntry };
    // SAFETY: The throwing append fixture implements the only Pi method used by the store.
    const pi = piFixture as typeof piFixture & ExtensionAPI;
    const contextFixture = {
      sessionManager: {
        getEntries: (): never => {
          throw new Error("read-secret");
        },
      },
    };
    // SAFETY: The throwing read fixture implements the only context method used by the store.
    const ctx = contextFixture as typeof contextFixture & ExtensionContext;
    const store = makeHostHerdrForkLinkStore(pi, ctx, OWNER);

    expect(store.restore()).toEqual({ _tag: "malformed" });
    expect(store.record(LINK)).toBe(false);
  });
});
