import { describe, expect, it, vi } from "vitest";
import type { CosmicFooterTextContribution } from "../src/protocol/protocol.ts";
import {
  FOOTER_PRE_SESSION_KEY_LIMIT,
  FOOTER_REENTRANT_OPERATION_LIMIT,
  createFooterRegistry,
  type FooterRegistry,
} from "../src/footer/registry.ts";

const text = (id: string, value = id): CosmicFooterTextContribution => ({
  kind: "text",
  id,
  region: "details",
  text: value,
});

function registry(onRender: (registry: FooterRegistry) => void = () => undefined) {
  const renders = vi.fn(() => onRender(store));
  const store = createFooterRegistry({ requestRender: renders, sessionActive: () => true });
  const ids = () => store.snapshot().contributions.map((entry) => entry.id);
  return { store, renders, ids };
}

describe("footer registry", () => {
  it("keeps identifiers collision-safe and publishes a frozen renderer snapshot", () => {
    const { store, ids } = registry();
    store.upsert("a", text("b:c", "first"));
    store.upsert("a:b", text("c", "second"));
    store.upsert("a", text("b\0c", "third"));
    store.upsert("a\0b", text("c", "fourth"));
    expect(ids()).toEqual(["b:c", "c", "b\0c", "c"]);
    const snapshot = store.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.contributions)).toBe(true);
    expect(Object.isFrozen(snapshot.contributions[0])).toBe(true);

    store.remove("a", "b\0c");
    store.remove("a");
    expect(store.snapshot().contributions).toEqual([
      expect.objectContaining({ id: "c", text: "second" }),
      expect.objectContaining({ id: "c", text: "fourth" }),
    ]);
  });

  it("queues an operation emitted during another behind it, detached when emitted", () => {
    const observed: string[][] = [];
    const { store, ids } = registry((current) => {
      observed.push(ids());
      if (ids().includes("nested")) return;
      const nested = text("nested", "before");
      current.upsert("owner", nested);
      nested.text = "after";
    });
    store.upsert("owner", text("outer"));
    expect(observed).toEqual([["outer"], ["outer", "nested"]]);
    expect(store.snapshot().contributions[1]).toMatchObject({ id: "nested", text: "before" });
  });

  it("bounds a self-perpetuating render loop and recovers for the next operation", () => {
    const { store, renders } = registry((current) => current.upsert("owner", text("loop")));
    store.upsert("owner", text("loop"));
    expect(renders).toHaveBeenCalledTimes(1 + FOOTER_REENTRANT_OPERATION_LIMIT);

    renders.mockClear();
    store.remove("missing");
    store.upsert("owner", text("loop"));
    expect(renders).toHaveBeenCalledTimes(1 + FOOTER_REENTRANT_OPERATION_LIMIT);
  });

  it("isolates a throwing render request without stranding queued work", () => {
    const { store, ids } = registry((current) => {
      if (!ids().includes("queued")) current.upsert("owner", text("queued"));
      throw new Error("secret render payload");
    });
    expect(() => store.upsert("owner", text("outer"))).not.toThrow();
    expect(ids()).toEqual(["outer", "queued"]);
  });

  it("caps distinct keys only while no session is active", () => {
    let active = false;
    const store = createFooterRegistry({
      requestRender: () => undefined,
      sessionActive: () => active,
    });
    const upsertMany = (prefix: string, count: number) => {
      for (let index = 0; index < count; index++) store.upsert("owner", text(`${prefix}${index}`));
    };
    upsertMany("early", FOOTER_PRE_SESSION_KEY_LIMIT + 2);
    const early = store.snapshot().contributions.map((entry) => entry.id);
    expect(early).toHaveLength(FOOTER_PRE_SESSION_KEY_LIMIT);
    expect(early[0]).toBe("early2");
    store.upsert("owner", text("early2", "replaced"));
    expect(store.snapshot().contributions).toHaveLength(FOOTER_PRE_SESSION_KEY_LIMIT);

    active = true;
    upsertMany("session", 2);
    expect(store.snapshot().contributions).toHaveLength(FOOTER_PRE_SESSION_KEY_LIMIT + 2);
  });
});
