import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";
const run = (code: string) => CodeMode.execute({ code });
describe("bounded encoding", () => {
  it.effect("encodes UTF-8 including astral and unpaired surrogate characters", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const e=new TextEncoder();const d=new TextDecoder();return [e.encoding,d.encoding,e.encode('a😀\\ud800').toHex(),d.decode(e.encode('hé😀')),e.encode().length,d.decode(), e instanceof TextEncoder,d instanceof TextDecoder];`,
        ),
      ).toMatchObject({
        ok: true,
        value: ["utf-8", "utf-8", "61f09f9880efbfbd", "hé😀", 0, "", true, true],
      });
    }),
  );
  it.effect("implements fatal and BOM flags without streaming state", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const bom=Uint8Array.fromHex('efbbbf61'); return [new TextDecoder().decode(bom),new TextDecoder('utf8',{ignoreBOM:true}).decode(bom),new TextDecoder().decode(Uint8Array.fromHex('ff')),new TextDecoder('utf-8',{fatal:true}).fatal];`,
        ),
      ).toMatchObject({ ok: true, value: ["a", "\ufeffa", "�", true] });
      expect(
        yield* run(
          `return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.fromHex('ff'));`,
        ),
      ).toMatchObject({ ok: false });
      for (const code of [
        `new TextDecoder('latin1')`,
        `new TextDecoder().decode(new Uint8Array(),{stream:true})`,
        `new TextEncoder().encodeInto('a',new Uint8Array(1))`,
        `new TextDecoder().decode([65])`,
      ])
        expect(yield* run(code)).toMatchObject({ ok: false });
    }),
  );
  it.effect("supports binary-string base64 with a strict canonical subset", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`return [btoa('a\\xff'),atob('Yf8='),atob(btoa('')),['a','b'].map(btoa)];`),
      ).toMatchObject({ ok: false }); // btoa requires exactly one argument, unlike callbacks that receive an index.
      expect(yield* run(`return [btoa('a\\xff'),atob('Yf8='),atob(btoa(''))];`)).toMatchObject({
        ok: true,
        value: ["Yf8=", "aÿ", ""],
      });
      expect(yield* run(`return btoa('😀')`)).toMatchObject({ ok: false });
      expect(yield* run(`return atob('YQ')`)).toMatchObject({ ok: false });
    }),
  );
});
