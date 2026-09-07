import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

interface HarnessOptions {
  readonly initialEntries?: ReadonlyArray<CustomEntryFixture>;
  readonly initialProbe?: SessionHeaderProbe | undefined;
  readonly initialThrow?: ThrowingOperation | undefined;
}

interface MutableOwner {
  readonly sessionId?: string | undefined;
  readonly sessionPath?: string | undefined;
}

const harness = (options: HarnessOptions = {}) => {
  const entries = [...(options.initialEntries ?? [])];
  let currentOwner: MutableOwner = { ...OWNER };
  let currentProbe: SessionHeaderProbe =
    options.initialProbe ?? ({ _tag: "valid", header: { id: OWNER.sessionId } } as const);
  let throwing = options.initialThrow;
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
  const piFixture = { appendEntry };
  // SAFETY: The store uses only appendEntry, which this fixture implements.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const contextFixture = {
    sessionManager: { getSessionId, getSessionFile, getEntries },
  };
  // SAFETY: The fixture implements every session-manager method used by the store.
  const ctx = contextFixture as typeof contextFixture & ExtensionContext;
  const store = makeHostHerdrBtwLinkStore(pi, ctx, OWNER, { probeSessionHeader });

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

describe("host reusable-link store", () => {
  it("uses the supplied launch owner without recapturing it at construction", () => {
    const h = harness({ initialThrow: "sessionId" });

    expect(h.getSessionId).not.toHaveBeenCalled();
    expect(h.getSessionFile).not.toHaveBeenCalled();
    h.setThrowing(undefined);
    expect(h.store.restore()).toEqual({ _tag: "none" });
    expect(h.store.record(RECORD)).toBe("recorded");
    expect(h.appendEntry).toHaveBeenCalledWith(HERDR_BTW_LINK_ENTRY_TYPE, LINK);
    expect(h.store.restore()).toEqual({ _tag: "restored", link: LINK });
  });

  it("revalidates owner and header changes after successful restore and record", () => {
    for (const change of ["sessionId", "sessionPath", "header"] as const) {
      const h = harness();
      expect(h.store.restore()).toEqual({ _tag: "none" });
      expect(h.store.record(RECORD)).toBe("recorded");
      expect(h.store.restore()).toEqual({ _tag: "restored", link: LINK });
      h.appendEntry.mockClear();

      if (change === "header") h.setProbe({ _tag: "valid", header: { id: "replacement-session" } });
      else if (change === "sessionId") h.setOwner({ sessionId: "replacement-session" });
      else h.setOwner({ sessionPath: "/sessions/replacement.jsonl" });

      expect(h.store.restore()).toEqual({ _tag: "malformed" });
      expect(h.store.record(RECORD)).toBe("refused");
      expect(h.appendEntry).not.toHaveBeenCalled();
      expect(h.entries).toEqual([
        { type: "custom", customType: HERDR_BTW_LINK_ENTRY_TYPE, data: LINK },
      ]);
    }
  });

  it("ignores an inherited ancestor link", () => {
    const inherited: HerdrBtwLink = {
      ...LINK,
      parentSessionId: "ancestor-session",
      parentSessionPath: "/sessions/ancestor.jsonl",
    };
    const h = harness({
      initialEntries: [{ type: "custom", customType: HERDR_BTW_LINK_ENTRY_TYPE, data: inherited }],
    });

    expect(h.store.restore()).toEqual({ _tag: "none" });
  });

  it("fails closed without reading or appending after the live owner changes", () => {
    for (const owner of [
      { sessionId: "replacement-session" },
      { sessionPath: "/sessions/replacement.jsonl" },
      { sessionId: undefined },
      { sessionPath: undefined },
    ]) {
      const h = harness();
      h.setOwner(owner);

      expect(h.store.restore()).toEqual({ _tag: "malformed" });
      expect(h.getEntries).not.toHaveBeenCalled();
      expect(h.store.record(RECORD)).toBe("refused");
      expect(h.appendEntry).not.toHaveBeenCalled();
    }
  });

  it("fails closed when live owner revalidation throws", () => {
    for (const operation of ["sessionId", "sessionFile", "probe"] as const) {
      const h = harness();
      h.setThrowing(operation);

      expect(h.store.restore()).toEqual({ _tag: "malformed" });
      expect(h.store.record(RECORD)).toBe("refused");
      expect(h.appendEntry).not.toHaveBeenCalled();
    }
  });

  it("fails closed when the bounded parent header is missing or belongs to another session", () => {
    for (const probe of [
      { _tag: "invalid" as const },
      { _tag: "valid" as const, header: { id: "replacement-session" } },
    ]) {
      const h = harness({ initialProbe: probe });

      expect(h.store.restore()).toEqual({ _tag: "malformed" });
      expect(h.getEntries).not.toHaveBeenCalled();
      expect(h.store.record(RECORD)).toBe("refused");
      expect(h.appendEntry).not.toHaveBeenCalled();
    }
  });

  it("contains entry-read failures and treats any append throw as uncertain", () => {
    const readFailure = harness();
    readFailure.setThrowing("entries");
    expect(readFailure.store.restore()).toEqual({ _tag: "malformed" });

    const appendFailure = harness();
    appendFailure.setThrowing("append");
    expect(appendFailure.store.record(RECORD)).toBe("uncertain");
    expect(appendFailure.entries).toEqual([]);

    const mutationThenThrow = harness();
    mutationThenThrow.setThrowing("appendAfterMutation");
    expect(mutationThenThrow.store.record(RECORD)).toBe("uncertain");
    expect(mutationThenThrow.entries).toEqual([
      { type: "custom", customType: HERDR_BTW_LINK_ENTRY_TYPE, data: LINK },
    ]);
    expect(mutationThenThrow.appendEntry).toHaveBeenCalledOnce();
  });
});
