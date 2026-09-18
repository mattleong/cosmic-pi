import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Namespace, Tool } from "../src/index.js";

describe("feature composition", () => {
  it.live("destructures byte iterators and sends encoded strings across the tool boundary", () =>
    Effect.gen(function* () {
      const received: string[] = [];
      const runtime = CodeMode.make({
        tools: {
          save: Tool.make({
            description: "Store encoded bytes",
            input: Schema.String,
            output: Schema.String,
            run: (input) =>
              Effect.sync(() => {
                received.push(input);
                return input;
              }),
          }),
        },
      });
      const result = yield* runtime.execute(`
        const bytes = new TextEncoder().encode("ABC");
        let first, tail;
        [first, ...tail] = bytes;
        const [bound, ...rest] = bytes;
        const sent = await tools.save(bytes.toBase64());
        return { first, tail, bound, rest, sent,
          decoded: new TextDecoder().decode(Uint8Array.fromBase64(sent)) };
      `);
      expect(result.ok && result.value).toEqual({
        first: 65,
        tail: [66, 67],
        bound: 65,
        rest: [66, 67],
        sent: "QUJD",
        decoded: "ABC",
      });
      expect(received).toEqual(["QUJD"]);
    }),
  );

  it.live("evaluates computed assignment references before effectful right-hand sides", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const runtime = CodeMode.make({
        tools: {
          mark: Tool.make({
            description: "Record an assignment step",
            input: Schema.String,
            output: Schema.String,
            run: (input) =>
              Effect.sync(() => {
                events.push(input);
                return input;
              }),
          }),
        },
      });
      const result = yield* runtime.execute(`
        const target = { slot: "old" };
        target[await tools.mark("slot")] += await tools.mark("new");
        ({ [await tools.mark("source")]: target[await tools.mark("destination")] }
          = { source: "assigned" });
        return target;
      `);
      expect(result.ok && result.value).toEqual({ slot: "oldnew", destination: "assigned" });
      expect(events).toEqual(["slot", "new", "source", "destination"]);
    }),
  );

  it.live("discovers a namespace by its description and invokes its constrained tool", () =>
    Effect.gen(function* () {
      const received: string[] = [];
      const runtime = CodeMode.make({
        tools: {
          documents: Namespace.make({
            description: "archival storage",
            tools: {
              put: Tool.make({
                description: "Store a label",
                input: { type: "string", minLength: 2, maxLength: 12, pattern: "^[a-z]+$" },
                output: Schema.String,
                run: (input) =>
                  Effect.gen(function* () {
                    const label = yield* Schema.decodeUnknownEffect(Schema.String)(input);
                    received.push(label);
                    return label;
                  }),
              }),
            },
          }),
        },
        discovery: { catalogBudget: 0 },
      });
      const result = yield* runtime.execute(`
        const page = await tools.$codemode.search({ query: "archival" });
        const entry = page.items[0];
        const label = new TextDecoder().decode(Uint8Array.fromHex("6e6f7465"));
        return { path: entry.path, signature: entry.signature,
          value: await tools.documents.put(label), keys: Object.keys(tools.documents) };
      `);
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toMatchObject({
        path: "tools.documents.put",
        value: "note",
        keys: ["put"],
      });
      for (const tag of ["@minLength 2", "@maxLength 12", "@pattern"])
        expect(result.ok && result.value).toMatchObject({
          signature: expect.stringContaining(tag),
        });
      expect(received).toEqual(["note"]);
    }),
  );
});
