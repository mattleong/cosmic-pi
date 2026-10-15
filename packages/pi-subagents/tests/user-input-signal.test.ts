import type { InputEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionContextFixture, recordingExtensionHost } from "pi-cosmic-core/testing";
import { registerUserInputSignal } from "../src/boundary/host-user-input.ts";

const input = (source: InputEvent["source"]): InputEvent => ({
  type: "input",
  text: "Use the other branch.",
  source,
});

describe("user input signal", () => {
  it.effect("aborts open waits for the user's message but not for extension input", () =>
    Effect.gen(function* () {
      const host = recordingExtensionHost();
      const current = registerUserInputSignal(host.pi);
      const send = (source: InputEvent["source"]) =>
        Effect.promise(() => host.emit("input", extensionContextFixture(), input(source)));
      const waiting = current();

      yield* send("extension");
      expect(waiting.aborted).toBe(false);

      yield* send("interactive");
      expect(waiting.aborted).toBe(true);
      expect(current().aborted).toBe(false);

      const next = current();
      yield* send("rpc");
      expect(next.aborted).toBe(true);
    }),
  );
});
