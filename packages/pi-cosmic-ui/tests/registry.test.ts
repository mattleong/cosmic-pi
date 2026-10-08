import { describe, expect, it, vi } from "vitest";
import type { CosmicFooterTextContribution } from "../src/protocol/protocol.ts";
import {
  FOOTER_PRE_SESSION_KEY_LIMIT,
  FOOTER_REENTRANT_OPERATION_LIMIT,
  makeFooterRegistry,
  type FooterRegistry,
} from "../src/footer/registry.ts";

const text = (id: string, value = id): CosmicFooterTextContribution => ({
  kind: "text",
  id,
  region: "details",
  text: value,
});

/** A registry whose render request runs `onRender` with the registry itself. */
function registry(onRender: (registry: FooterRegistry) => void = () => undefined) {
  const renders = vi.fn(() => onRender(store));
  const store = makeFooterRegistry({ requestRender: renders, sessionActive: () => true });
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

  it("copies frozen raw accessors and reuses only canonical contribution identity", () => {
    const { store } = registry();
    let value = "before";
    let reads = 0;
    const raw = Object.freeze({
      kind: "text" as const,
      id: "accessor",
      region: "details" as const,
      get text() {
        reads++;
        return value;
      },
    });

    store.upsert("owner", raw);
    const snapshot = store.snapshot();
    const canonical = snapshot.contributions[0];
    expect(canonical).not.toBe(raw);
    expect(Object.isFrozen(canonical)).toBe(true);
    const readsAfterUpsert = reads;
    expect(readsAfterUpsert).toBeGreaterThan(0);
    expect(canonical).toMatchObject({ text: "before" });

    value = "after";
    expect(canonical).toMatchObject({ text: "before" });
    expect(reads).toBe(readsAfterUpsert);

    if (!canonical) throw new Error("Expected a canonical contribution.");
    store.upsert("owner", canonical);
    expect(store.snapshot()).toBe(snapshot);
    expect(reads).toBe(readsAfterUpsert);
  });

  it("keeps snapshot identity for render-only work and still renders", () => {
    const { store, renders } = registry();
    store.upsert("owner", text("entry"));
    const snapshot = store.snapshot();
    const canonical = snapshot.contributions[0];
    if (!canonical) throw new Error("Expected a canonical contribution.");

    renders.mockClear();
    store.upsert("owner", canonical);
    store.upsert("owner", canonical);
    expect(store.snapshot()).toBe(snapshot);
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("publishes before rendering, skips no-op removal, and clears without rendering", () => {
    const observed: string[][] = [];
    const { store, ids } = registry(() => observed.push(ids()));
    store.upsert("owner", text("entry"));
    expect(observed).toEqual([["entry"]]);
    store.remove("owner", "missing");
    expect(observed).toEqual([["entry"]]);
    store.remove("owner", "entry");
    expect(observed).toEqual([["entry"], []]);

    store.upsert("owner", text("entry"));
    observed.length = 0;
    store.clear();
    expect(ids()).toEqual([]);
    expect(observed).toEqual([]);
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

  it("clear drops work queued by the current operation", () => {
    const { store, ids } = registry((current) => {
      if (!ids().includes("outer")) return;
      current.upsert("owner", text("queued"));
      current.clear();
    });
    store.upsert("owner", text("outer"));
    expect(ids()).toEqual([]);
    store.upsert("owner", text("later"));
    expect(ids()).toEqual(["later"]);
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
    const store = makeFooterRegistry({
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
