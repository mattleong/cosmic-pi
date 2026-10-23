import type { CustomEntry, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  makeHostHerdrBtwLinkStore,
  type HerdrBtwLinkRecord,
} from "../src/boundary/host-link-store.ts";
import { SessionHeaderProbe } from "../src/boundary/session-file.ts";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  HerdrBtwLinkRestoration,
  type HerdrBtwLink,
} from "../src/btw/link.ts";

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

interface OwnerState {
  readonly sessionId: string;
  readonly sessionPath: string | undefined;
}

interface MutableOwner {
  readonly sessionId?: string;
  readonly sessionPath?: string | undefined;
}

const sessionEntry = (entry: CustomEntryFixture, index: number): CustomEntry => ({
  ...entry,
  id: `entry-${index + 1}`,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const harness = (initialThrow?: ThrowingOperation) => {
  const entries: CustomEntryFixture[] = [];
  let currentOwner: OwnerState = { ...OWNER };
  let currentProbe: SessionHeaderProbe = SessionHeaderProbe.valid({
    header: { id: OWNER.sessionId },
  });
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
  const getEntries = vi.fn((): SessionEntry[] => {
    if (throwing === "entries") throw new Error("entries-secret");
    return Arr.map(entries, sessionEntry);
  });
  const appendEntry = vi.fn<ExtensionAPI["appendEntry"]>((customType, data) => {
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
  it.each<[string, (h: Harness) => void]>([
    ["a replaced owner ID", (h) => h.setOwner({ sessionId: "replacement-session" })],
    [
      "another session's parent header",
      (h) => h.setProbe(SessionHeaderProbe.valid({ header: { id: "replacement-session" } })),
    ],
  ])("revalidates every call and fails closed after %s", (_name, change) => {
    const h = harness();
    expect(h.store.restore()).toEqual(HerdrBtwLinkRestoration.none());
    expect(h.store.record(RECORD)).toBe("recorded");
    expect(h.store.restore()).toEqual(HerdrBtwLinkRestoration.restored({ link: LINK }));
    h.getEntries.mockClear();
    h.appendEntry.mockClear();

    change(h);

    expect(h.store.restore()).toEqual(HerdrBtwLinkRestoration.malformed());
    expect(h.getEntries).not.toHaveBeenCalled();
    expect(h.store.record(RECORD)).toBe("refused");
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(h.entries).toEqual([
      { type: "custom", customType: HERDR_BTW_LINK_ENTRY_TYPE, data: LINK },
    ]);
  });

  it("contains entry-read failures and treats any append throw as uncertain", () => {
    expect(harness("entries").store.restore()).toEqual(HerdrBtwLinkRestoration.malformed());

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
