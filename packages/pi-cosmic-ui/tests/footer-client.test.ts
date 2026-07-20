import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createCosmicFooterClient } from "../src/footer/client.ts";

it("queries, publishes plain contributions, invalidates, and removes ownership", () => {
  const emitted: Array<{ name: string; value: unknown }> = [];
  const events = {
    emit(name: string, value: unknown) {
      emitted.push({ name, value });
      if (name.endsWith("host:query")) (value as { respond(): void }).respond();
    },
  } as ExtensionAPI["events"];
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
