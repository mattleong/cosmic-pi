import { expect, vi } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeOwnedFormDialogsHost } from "../src/boundary/host-form-dialogs.ts";
import { makeAskUserPromptGate } from "../src/boundary/host-prompt.ts";
import { deferredPromise, opaqueFixture } from "pi-cosmic-core/testing";
import { formOwner as owner } from "./support/questionnaire.ts";
import type { OwnedFormRequest } from "../src/protocol.ts";
import { AskUserService } from "../src/questionnaire/service.ts";

it.effect("rejects malformed formatted defaults before opening native UI", () =>
  Effect.gen(function* () {
    const select = vi.fn(() => Promise.resolve(undefined));
    const input = vi.fn(() => Promise.resolve(undefined));
    const ctx = opaqueFixture({ ui: { select, input } });
    const layer = AskUserService.layer(
      () => Effect.never,
      undefined,
      "test",
      undefined,
      makeOwnedFormDialogsHost(ctx),
    );
    for (const [format, value] of [
      ["email", "a@."],
      ["email", "a..b@example.test"],
      ["uri", "\u0000https://example.test"],
    ] as const) {
      const error = yield* AskUserService.use((service) =>
        service.askForm(
          {
            kind: "form",
            message: "",
            fields: [{ key: "value", type: "string", required: true, format, default: value }],
          },
          owner,
        ),
      ).pipe(Effect.flip, Effect.provide(layer));
      expect(error._tag).toBe("AskUserValidationError");
    }
    expect(select).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  }),
);

it.effect("supports native typed editing, private review and explicit optional omission", () =>
  Effect.gen(function* () {
    const selections = [0, 1, 1, 1, 1, 2, 1, 3, 2, 4];
    const inputs = ["0", ""];
    const ctx = opaqueFixture({
      ui: {
        select: (_title: string, choices: string[]) =>
          Promise.resolve(choices[selections.shift() ?? -1]),
        input: () => Promise.resolve(inputs.shift()),
      },
    });
    const request: OwnedFormRequest = {
      kind: "form",
      message: "Private",
      fields: [
        { key: "false", type: "boolean", required: true },
        { key: "zero", type: "integer", required: true },
        { key: "empty", type: "string", required: true },
        { key: "optional", type: "string", default: "remove" },
      ],
    };
    expect(yield* makeOwnedFormDialogsHost(ctx)(request, owner)).toEqual({
      action: "accept",
      content: { false: false, zero: 0, empty: "" },
    });
  }),
);

it.effect("allows native 64-option multi-enums and returns consent without navigation", () =>
  Effect.gen(function* () {
    const selections = [0, 1, 63, 64, 1];
    const ctx = opaqueFixture({
      ui: {
        select: (_title: string, choices: string[]) =>
          Promise.resolve(choices[selections.shift() ?? -1]),
      },
    });
    expect(
      yield* makeOwnedFormDialogsHost(ctx)(
        {
          kind: "form",
          message: "",
          fields: [
            {
              key: "x",
              type: "multi-enum",
              options: Array.from({ length: 64 }, (_, index) => ({ value: String(index) })),
            },
          ],
        },
        owner,
      ),
    ).toEqual({ action: "accept", content: { x: ["63"] } });
    for (const [index, action] of ["accept", "decline", "cancel"].entries()) {
      const urlCtx = opaqueFixture({
        ui: { select: (_title: string, choices: string[]) => Promise.resolve(choices[index]) },
      });
      expect(
        yield* makeOwnedFormDialogsHost(urlCtx)(
          { kind: "url", message: "", url: "https://example.test/path" },
          owner,
        ),
      ).toEqual({ action });
    }
  }),
);

it.effect(
  "aborts native input and releases prompt ownership without waiting for a foreign Promise",
  () =>
    Effect.gen(function* () {
      const selections = [0, 1];
      let signal: AbortSignal | undefined;
      const completion = deferredPromise<string | undefined>();
      const ctx = opaqueFixture({
        ui: {
          select: (_title: string, choices: string[]) =>
            Promise.resolve(choices[selections.shift() ?? -1]),
          input: (_title: string, _placeholder: string, options: { signal: AbortSignal }) => {
            signal = options.signal;
            return completion.promise;
          },
        },
      });
      const gate = makeAskUserPromptGate();
      const controller = new AbortController();
      const pending = Effect.runPromise(
        makeOwnedFormDialogsHost(ctx, gate)(
          { kind: "form", message: "", fields: [{ key: "x", type: "string" }] },
          owner,
        ),
        { signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toBeDefined();
      yield* Effect.promise(() => vi.waitFor(() => expect(signal).toBeDefined()));
      controller.abort();
      yield* Effect.promise(() => rejected);
      expect(signal?.aborted).toBe(true);
      expect(gate.canOpen()).toBe(true);
    }),
);
