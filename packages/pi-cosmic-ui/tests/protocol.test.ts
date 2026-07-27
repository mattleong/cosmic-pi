import { describe, expect, test, vi } from "vitest";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import {
  COSMIC_UI_PROTOCOL_VERSION,
  isCosmicFooterInvalidateEvent,
  isCosmicFooterRemoveEvent,
  isCosmicFooterUpsertEvent,
  isCosmicUiHostQuery,
  normalizeCosmicFooterInvalidateEvent,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
} from "../src/protocol/protocol.ts";

function event(contribution: Record<string, unknown>) {
  return { version: COSMIC_UI_PROTOCOL_VERSION, owner: "test-owner", contribution };
}

describe("Cosmic UI protocol validation", () => {
  test("accepts valid text contributions and rejects malformed optional fields", () => {
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "text",
          id: "status",
          region: "details",
          text: "ready",
          tone: "success",
          align: "right",
          priority: 10,
        }),
      ),
    ).toBe(true);
    expect(
      isCosmicFooterUpsertEvent(
        event({ kind: "text", id: "status", region: "details", text: "ready", tone: "accent" }),
      ),
    ).toBe(true);
    expect(
      isCosmicFooterUpsertEvent(
        event({ kind: "text", id: "status", region: "details", text: "ready", tone: "purple" }),
      ),
    ).toBe(false);
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "text",
          id: "status",
          region: "details",
          text: "ready",
          priority: Number.NaN,
        }),
      ),
    ).toBe(false);
  });

  test("validates host, remove, and invalidate payloads through schemas", () => {
    expect(isCosmicUiHostQuery({ version: 1, respond() {} })).toBe(true);
    expect(isCosmicUiHostQuery({ version: 1, respond: "later" })).toBe(false);
    expect(isCosmicFooterRemoveEvent({ version: 1, owner: "owner", id: "item" })).toBe(true);
    expect(isCosmicFooterRemoveEvent({ version: 1, owner: "", id: "item" })).toBe(false);
    expect(isCosmicFooterInvalidateEvent({ version: 1 })).toBe(true);
    expect(isCosmicFooterInvalidateEvent({ version: 1, owner: 42 })).toBe(false);
  });

  test("returns false for hostile accessors and proxies without throwing", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
        ownKeys() {
          throw new Error("hostile keys");
        },
      },
    );
    const throwingVersion = Object.defineProperty({}, "version", {
      get() {
        throw new Error("hostile version");
      },
    });
    for (const guard of [
      isCosmicUiHostQuery,
      isCosmicFooterUpsertEvent,
      isCosmicFooterRemoveEvent,
      isCosmicFooterInvalidateEvent,
    ]) {
      expect(() => guard(hostile)).not.toThrow();
      expect(guard(hostile)).toBe(false);
      expect(() => guard(throwingVersion)).not.toThrow();
      expect(guard(throwingVersion)).toBe(false);
    }
  });

  test("normalizes stateful getters exactly once into detached plain events", () => {
    const respond = vi.fn();
    const once = <A>(value: A) => {
      let reads = 0;
      return {
        get value() {
          reads++;
          if (reads > 1) throw new Error("read twice");
          return value;
        },
        reads: () => reads,
      };
    };
    const queryRespond = once(respond);
    const owner = once("owner");
    const text = once("ready");
    const removeId = once("item");
    const invalidateOwner = once("owner");

    const query = normalizeCosmicUiHostQuery({
      version: 1,
      get respond() {
        return queryRespond.value;
      },
    });
    const upsert = normalizeCosmicFooterUpsertEvent({
      version: 1,
      get owner() {
        return owner.value;
      },
      contribution: {
        kind: "text",
        id: "status",
        region: "details",
        get text() {
          return text.value;
        },
      },
    });
    const remove = normalizeCosmicFooterRemoveEvent({
      version: 1,
      owner: "owner",
      get id() {
        return removeId.value;
      },
    });
    const invalidate = normalizeCosmicFooterInvalidateEvent({
      version: 1,
      get owner() {
        return invalidateOwner.value;
      },
      id: "item",
    });

    query?.respond();
    expect(respond).toHaveBeenCalledOnce();
    expect(upsert).toEqual(expect.objectContaining({ owner: "owner" }));
    expect(upsert?.contribution).toEqual(expect.objectContaining({ text: "ready" }));
    expect(remove).toEqual({ version: 1, owner: "owner", id: "item" });
    expect(invalidate).toEqual({ version: 1, owner: "owner", id: "item" });
    expect([
      queryRespond.reads(),
      owner.reads(),
      text.reads(),
      removeId.reads(),
      invalidateOwner.reads(),
    ]).toEqual([1, 1, 1, 1, 1]);
  });

  test("turns throwing getter reads into bounded operation-only diagnostics", () => {
    const callbacks = makeHostCallbackBoundary(2);
    const throwing = Object.defineProperty({}, "version", {
      get() {
        throw new Error("secret protocol payload");
      },
    });
    for (const [operation, normalize] of [
      ["host-query", normalizeCosmicUiHostQuery],
      ["protocol-upsert", normalizeCosmicFooterUpsertEvent],
      ["protocol-remove", normalizeCosmicFooterRemoveEvent],
      ["protocol-invalidate", normalizeCosmicFooterInvalidateEvent],
    ] as const)
      expect(callbacks.invoke(operation, () => normalize(throwing), undefined)).toBeUndefined();

    expect(callbacks.diagnostics()).toEqual([
      { operation: "protocol-remove" },
      { operation: "protocol-invalidate" },
    ]);
    expect(callbacks.diagnostics().some((entry) => "message" in entry)).toBe(false);
  });

  test("validates surface placement and lifecycle callbacks", () => {
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "surface",
          id: "media",
          region: "media",
          preferredWidth: 8,
          preferredPlacement: "inline-right",
          render: () => [],
        }),
      ),
    ).toBe(true);
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "surface",
          id: "media",
          region: "media",
          preferredWidth: 8,
          preferredPlacement: "floating",
          render: () => [],
        }),
      ),
    ).toBe(false);
    expect(
      isCosmicFooterUpsertEvent(
        event({
          kind: "surface",
          id: "media",
          region: "media",
          preferredWidth: 8,
          attach: "later",
          render: () => [],
        }),
      ),
    ).toBe(false);
  });
});
