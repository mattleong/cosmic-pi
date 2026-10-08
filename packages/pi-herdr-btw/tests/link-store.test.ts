import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  makeHostHerdrBtwLinkStore,
  type HerdrBtwLinkRecord,
} from "../src/boundary/host-link-store.ts";
import type { SessionHeaderProbe } from "../src/boundary/session-file.ts";
import { HERDR_BTW_LINK_ENTRY_TYPE, type HerdrBtwLink } from "../src/btw/link.ts";

const OWNER = {
  sessionId: "parent-session",
  sessionPath: "/sessions/parent.jsonl",
} as const;

const RECORD: HerdrBtwLinkRecord = {
  childSessionId: "child-session",
  childSessionPath: "/sessions/child.jsonl",
  agentName: "btw-parent-p2",
  terminalId: "term-child",
};

const LINK: HerdrBtwLink = {
  version: 1,
  parentSessionId: OWNER.sessionId,
  parentSessionPath: OWNER.sessionPath,
  ...RECORD,
};

interface CustomEntryFixture {
  readonly type: "custom";
  readonly customType: string;
  readonly data: unknown;
}

type ThrowingOperation =
  | "sessionId"
  | "sessionFile"
  | "probe"
  | "entries"
  | "append"
  | "appendAfterMutation";

interface MutableOwner {
  readonly sessionId?: string | undefined;
  readonly sessionPath?: string | undefined;
}

const harness = (initialThrow?: ThrowingOperation) => {
  const entries: CustomEntryFixture[] = [];
  let currentOwner: MutableOwner = { ...OWNER };
  let currentProbe: SessionHeaderProbe = { _tag: "valid", header: { id: OWNER.sessionId } };
  let throwing = initialThrow;
  const getSessionId = vi.fn(() => {
    if (throwing === "sessionId") throw new Error("session-id-secret");
    return currentOwner.sessionId;
  });
  const getSessionFile = vi.fn(() => {
    if (throwing === "sessionFile") throw new Error("session-file-secret");
    return currentOwner.sessionPath;
  });
  const probeSessionHeader = vi.fn((path: string) => {
    if (throwing === "probe") throw new Error("probe-secret");
    expect(path).toBe(OWNER.sessionPath);
    return currentProbe;
  });
  const getEntries = vi.fn(() => {
    if (throwing === "entries") throw new Error("entries-secret");
    return entries;
  });
  const appendEntry = vi.fn((customType: string, data: HerdrBtwLink) => {
    if (throwing === "append") throw new Error("append-secret");
    entries.push({ type: "custom", customType, data });
    if (throwing === "appendAfterMutation") throw new Error("append-secret");
  });
  const store = makeHostHerdrBtwLinkStore(
    extensionApiFixture({ appendEntry }),
    extensionContextFixture({ sessionManager: { getSessionId, getSessionFile, getEntries } }),
    OWNER,
    probeSessionHeader,
  );

  return {
    appendEntry,
    entries,
    getEntries,
    getSessionFile,
    getSessionId,
    probeSessionHeader,
    setOwner: (owner: MutableOwner) => {
      currentOwner = { ...currentOwner, ...owner };
    },
    setProbe: (probe: SessionHeaderProbe) => {
      currentProbe = probe;
    },
    setThrowing: (operation: ThrowingOperation | undefined) => {
      throwing = operation;
    },
    store,
  };
};
type Harness = ReturnType<typeof harness>;

describe("host reusable-link store", () => {
  it("uses the supplied launch owner without recapturing it at construction", () => {
    const h = harness("sessionId");

    expect(h.getSessionId).not.toHaveBeenCalled();
    expect(h.getSessionFile).not.toHaveBeenCalled();
    h.setThrowing(undefined);
    expect(h.store.restore()).toEqual({ _tag: "none" });
    expect(h.store.record(RECORD)).toBe("recorded");
    expect(h.appendEntry).toHaveBeenCalledWith(HERDR_BTW_LINK_ENTRY_TYPE, LINK);
    expect(h.store.restore()).toEqual({ _tag: "restored", link: LINK });
  });

  it.each<[string, (h: Harness) => void]>([
    ["a replaced owner ID", (h) => h.setOwner({ sessionId: "replacement-session" })],
    ["a replaced owner path", (h) => h.setOwner({ sessionPath: "/sessions/replacement.jsonl" })],
    ["a missing owner ID", (h) => h.setOwner({ sessionId: undefined })],
    ["a missing owner path", (h) => h.setOwner({ sessionPath: undefined })],
    ["a missing parent header", (h) => h.setProbe({ _tag: "invalid" })],
    [
      "another session's parent header",
      (h) => h.setProbe({ _tag: "valid", header: { id: "replacement-session" } }),
    ],
    ["a throwing session ID read", (h) => h.setThrowing("sessionId")],
    ["a throwing session file read", (h) => h.setThrowing("sessionFile")],
    ["a throwing header probe", (h) => h.setThrowing("probe")],
  ])("revalidates every call and fails closed after %s", (_name, change) => {
    const h = harness();
    expect(h.store.restore()).toEqual({ _tag: "none" });
    expect(h.store.record(RECORD)).toBe("recorded");
    expect(h.store.restore()).toEqual({ _tag: "restored", link: LINK });
    h.getEntries.mockClear();
    h.appendEntry.mockClear();

    change(h);

    expect(h.store.restore()).toEqual({ _tag: "malformed" });
    expect(h.getEntries).not.toHaveBeenCalled();
    expect(h.store.record(RECORD)).toBe("refused");
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(h.entries).toEqual([
      { type: "custom", customType: HERDR_BTW_LINK_ENTRY_TYPE, data: LINK },
    ]);
  });

  it("contains entry-read failures and treats any append throw as uncertain", () => {
    expect(harness("entries").store.restore()).toEqual({ _tag: "malformed" });

    const appendFailure = harness("append");
    expect(appendFailure.store.record(RECORD)).toBe("uncertain");
    expect(appendFailure.entries).toEqual([]);

    const mutationThenThrow = harness("appendAfterMutation");
    expect(mutationThenThrow.store.record(RECORD)).toBe("uncertain");
    expect(mutationThenThrow.entries).toEqual([
      { type: "custom", customType: HERDR_BTW_LINK_ENTRY_TYPE, data: LINK },
    ]);
    expect(mutationThenThrow.appendEntry).toHaveBeenCalledOnce();
  });
});
