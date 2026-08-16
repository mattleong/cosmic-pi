import { expect, it, vi } from "vitest";
import { createCosmicFooterClient } from "../src/footer/client.ts";
import { normalizeCosmicUiHostQuery } from "../src/protocol/protocol.ts";
import { eventBusFixture } from "./support/host.ts";

it("queries, publishes plain contributions, invalidates, and removes ownership", () => {
  const emitted: Array<{ name: string; value: unknown }> = [];
  const events = eventBusFixture({
    emit<ValueInput>(name: string, value: ValueInput) {
      emitted.push({ name, value });
      if (name.endsWith("host:query")) normalizeCosmicUiHostQuery(value)?.respond();
    },
  });
  const client = createCosmicFooterClient(events, "owner");
  expect(client.query()).toBe(true);
  client.upsert({ kind: "text", id: "usage", region: "details", text: "ok" });
  client.invalidate("usage");
  client.shutdown();
  expect(emitted.map(({ name }) => name)).toEqual([
    "cosmic-ui:v1:host:query",
    "cosmic-ui:v1:footer:upsert",
    "cosmic-ui:v1:footer:invalidate",
    "cosmic-ui:v1:footer:remove",
  ]);
  expect(JSON.stringify(emitted[1]?.value)).toContain('"text":"ok"');
});

it("contains hostile event emitters and deactivates before shutdown removal", () => {
  let hostile = false;
  const emit = vi.fn(<Value>(name: string, value: Value) => {
    if (name.endsWith("host:query")) {
      normalizeCosmicUiHostQuery(value)?.respond();
      return;
    }
    if (hostile) throw new Error("event bus failure");
  });
  const client = createCosmicFooterClient(eventBusFixture({ emit }), "owner");
  expect(client.query()).toBe(true);
  hostile = true;

  expect(() =>
    client.upsert({ kind: "text", id: "usage", region: "details", text: "ok" }),
  ).not.toThrow();
  expect(() => client.invalidate("usage")).not.toThrow();
  expect(() => client.remove("usage")).not.toThrow();
  expect(() => client.shutdown()).not.toThrow();
  expect(client.active).toBe(false);

  const unavailable = createCosmicFooterClient(
    eventBusFixture({
      emit() {
        throw new Error("query failure");
      },
    }),
    "unavailable",
  );
  expect(unavailable.query()).toBe(false);
  expect(unavailable.active).toBe(false);
});
