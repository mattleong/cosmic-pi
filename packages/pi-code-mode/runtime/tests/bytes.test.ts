import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CodeMode } from "../src/index.js";
const run = (code: string) => CodeMode.execute({ code });

describe("owned bytes", () => {
  it.effect("constructs lengths, arrays, copies and iterables with byte coercion", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`function* values(){ yield 257; yield -1; yield 2.9; }
      const a = new Uint8Array(values()); const b = new Uint8Array(a); a[0] = 260;
      return [Array.from(a), [...b], new Uint8Array(3).length, a instanceof Uint8Array];`),
      ).toMatchObject({ ok: true, value: [[4, 255, 2], [1, 255, 2], 3, true] });
    }),
  );
  it.effect("shares subarray writes, copies slices and preserves overlapping set", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const a = new Uint8Array([1,2,3,4]); const view=a.subarray(1,3); const copy=a.slice(1,3);
      view[0]=9; a.set(a.subarray(0,3),1); return [[...a],[...view],[...copy],a.at(-1)];`),
      ).toMatchObject({ ok: true, value: [[1, 1, 9, 3], [1, 9], [2, 3], 3] });
    }),
  );
  it.effect("roundtrips canonical base64 and hex including empty bytes", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const b = Uint8Array.fromHex('00Ff10'); return [b.toHex(),b.toBase64(),Uint8Array.fromBase64('AP8Q').toHex(),new Uint8Array().toBase64(),Uint8Array.fromBase64('').length];`,
        ),
      ).toMatchObject({ ok: true, value: ["00ff10", "AP8Q", "00ff10", "", 0] });
      for (const text of ["Zg==", "Zm8=", "Zm9v", "AA==", "AAA="])
        expect(yield* run(`return Uint8Array.fromBase64('${text}').toBase64();`)).toMatchObject({
          ok: true,
          value: text,
        });
    }),
  );
  it.effect("refuses malformed encodings and unsupported options", () =>
    Effect.gen(function* () {
      for (const text of ["Zg", "Zh==", "Zm9=", "Z g==", "-w==", "A===", "===="])
        expect(yield* run(`return Uint8Array.fromBase64('${text}').length;`)).toMatchObject({
          ok: false,
        });
      for (const text of ["a", "0z", "aa bb"])
        expect(yield* run(`return Uint8Array.fromHex('${text}').length;`)).toMatchObject({
          ok: false,
        });
      expect(
        yield* run(`return new Uint8Array([1]).toBase64({alphabet:'base64url'});`),
      ).toMatchObject({ ok: false });
    }),
  );
  it.effect("keeps capacity fixed and rejects set before partial mutation", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const b=new Uint8Array([4,5]); try{b.set([1,2],1)}catch(e){} b[99]=2; return [...b];`,
        ),
      ).toMatchObject({ ok: true, value: [4, 5] });
    }),
  );
  it.effect("treats canonical numeric-string indices like numeric indices", () =>
    Effect.gen(function* () {
      expect(
        yield* run(`const b=new Uint8Array([4,5]); const invalid=['-0','-1','1.5','NaN','Infinity'];
        const reads=[]; for(const key of invalid) { b[key]=99; reads.push(b[key]===undefined); }
        b[-0]=7; b['1']=8; b[-1]=9; b[NaN]=9;
        let refused=false; try { b['01']=3; } catch(e) { refused=true; }
        return [[...b],reads,refused];`),
      ).toMatchObject({ ok: true, value: [[7, 8], [true, true, true, true, true], true] });
    }),
  );
  it.effect("projects JSON numeric properties but exposes no host buffer or methods", () =>
    Effect.gen(function* () {
      expect(
        yield* run(
          `const b=new Uint8Array([1,255]); return [JSON.stringify(b),b.buffer===undefined,b.storage===undefined,b.constructor===undefined,b.byteLength];`,
        ),
      ).toMatchObject({ ok: true, value: ['{"0":1,"1":255}', true, true, true, 2] });
      expect(
        yield* run(
          `const b=new Uint8Array([1,2]); return [JSON.stringify(b,['1','storage','buffer','01']), JSON.stringify(b,(key,value)=>{if(key==='0')b[1]=7;return value;})];`,
        ),
      ).toMatchObject({ ok: true, value: ['{"1":2}', '{"0":1,"1":7}'] });
    }),
  );
});
