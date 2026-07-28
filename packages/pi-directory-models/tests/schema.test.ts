// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, test } from "vitest";
import {
  DirectoryModelPreferenceSchema,
  makeDirectoryModelPreference,
} from "../src/config/schema.ts";

describe("directory model preference schema", () => {
  test("decodes the persisted preference shape", async () => {
    const preference = makeDirectoryModelPreference(
      "/work/cern",
      "openai-codex",
      "gpt-5.6-sol",
      "high",
    );
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(DirectoryModelPreferenceSchema)(preference)),
    ).resolves.toEqual(preference);
  });

  test("rejects unsupported versions and thinking levels", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(DirectoryModelPreferenceSchema)({
          version: 2,
          cwd: "/work/cern",
          provider: "openai-codex",
          model: "gpt-5.6-sol",
          thinkingLevel: "extreme",
        }),
      ),
    ).rejects.toBeDefined();
  });
});
