import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";
import { MAX_GUEST_COLLECTION_ENTRIES as cap } from "../src/interpreter/confinement.js";
const run = (code: string) => CodeMode.execute({ code });
describe("byte confinement", () => {
  it.effect("admits exact capacity and refuses expansion before encoding or construction", () =>
    Effect.gen(function* () {
      expect(yield* run(`return new Uint8Array(${cap}).length;`)).toMatchObject({
        ok: true,
        value: cap,
      });
      expect(
        yield* run(`return new TextEncoder().encode('a'.repeat(${cap})).length;`),
      ).toMatchObject({ ok: true, value: cap });
      for (const code of [
        `new Uint8Array(${cap + 1})`,
        `new Uint8Array(Infinity)`,
        `new TextEncoder().encode('é'.repeat(${cap / 2 + 1}))`,
        `new TextEncoder().encode('\\ud800'.repeat(${Math.floor(cap / 3) + 1}))`,
        `Uint8Array.fromHex('00'.repeat(${cap + 1}))`,
        `Uint8Array.fromBase64('AAAA'.repeat(${Math.floor(cap / 3) + 1}))`,
      ])
        expect(yield* run(code)).toMatchObject({ ok: false });
    }),
  );
  it.effect("rejects bytes recursively at final and tool boundaries with encoding guidance", () =>
    Effect.gen(function* () {
      for (const code of [
        `return new Uint8Array([1]);`,
        `return {nested:[new Uint8Array([1])]};`,
      ]) {
        const result = yield* run(code);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toMatch(/encod|base64|hex/i);
      }
      let called = false;
      const tool = Tool.make({
        description: "Receive data",
        input: Schema.Unknown,
        output: Schema.Boolean,
        run: () =>
          Effect.sync(() => {
            called = true;
            return true;
          }),
      });
      const result = yield* CodeMode.execute({
        tools: { host: { receive: tool } },
        code: `return await tools.host.receive({nested:[new Uint8Array([1])]});`,
      });
      expect(result.ok).toBe(false);
      expect(called).toBe(false);
      expect(
        yield* CodeMode.execute({
          tools: { host: { receive: tool } },
          code: `return await tools.host.receive({text:new Uint8Array([1]).toHex()});`,
        }),
      ).toMatchObject({ ok: true, value: true });
    }),
  );
  it.effect("never gives JSON or logs native storage and preserves old boundary formats", () =>
    Effect.gen(function* () {
      const result = yield* run(
        `console.log(new Uint8Array(${cap})); return [new Map(),new Set(),/a/,new URLSearchParams(),new Date(0),new URL('https://example.com')];`,
      );
      expect(result).toMatchObject({
        ok: true,
        value: [{}, {}, {}, {}, "1970-01-01T00:00:00.000Z", "https://example.com/"],
      });
      if (result.ok) {
        expect(result.logs).toHaveLength(1);
        expect(result.logs?.join("\n")).not.toContain("ArrayBuffer");
      }
    }),
  );
  it.effect("bounds array-to-number coercion before any byte mutation", () =>
    Effect.gen(function* () {
      for (const operation of ["new Uint8Array([a])", "b.set([3,a])", "b[0]=a"]) {
        expect(
          yield* run(`const s='1'.repeat(2097152); const a=[s,s]; const b=new Uint8Array([4,5]);
          let refused=false; try { ${operation}; } catch(e) { refused=true; }
          return [refused,[...b]];`),
        ).toMatchObject({ ok: true, value: [true, [4, 5]] });
      }
      expect(
        yield* run(`const b=new Uint8Array([[257],[],[1,2]]); b[2]=['258']; return [...b];`),
      ).toMatchObject({ ok: true, value: [1, 0, 2] });
    }),
  );
  it.effect("keeps absent ambient authorities absent", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`return [typeof fetch,typeof crypto,typeof Blob,typeof ArrayBuffer];`),
      ).toMatchObject({ ok: true, value: ["undefined", "undefined", "undefined", "undefined"] });
    }),
  );
});
