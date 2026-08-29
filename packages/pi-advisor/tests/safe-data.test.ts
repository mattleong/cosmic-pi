import { describe, expect, test } from "vitest";

import {
  SAFE_DATA_MAX_DEPTH,
  SAFE_DATA_MAX_ENTRIES,
  snapshotData,
  snapshotDataRecord,
} from "../src/domain/safe-data.ts";

interface DeepFixture {
  child?: DeepFixture;
  leaf?: string;
}

interface CyclicObjectFixture {
  self?: CyclicObjectFixture;
}

describe("safe data snapshots", () => {
  test("preserves the supported primitive corpus and rejects unsupported roots", () => {
    for (const [input, expected] of [
      [null, null],
      ["text", "text"],
      [true, true],
      [false, false],
      [42, 42],
    ] as const) {
      expect(snapshotData(input)).toBe(expected);
    }

    expect(Object.is(snapshotData(-0), -0)).toBe(true);
    for (const input of [undefined, Number.NaN, Infinity, -Infinity, 1n, Symbol("value")]) {
      expect(snapshotData(input)).toBeUndefined();
    }
    for (const input of [null, "text", true, 42, []]) {
      expect(snapshotDataRecord(input)).toBeUndefined();
    }
  });

  test("skips object accessors without invoking them and rejects array accessors", () => {
    let getterCalls = 0;
    const object = Object.defineProperties(
      { kept: 1 },
      {
        skipped: {
          enumerable: true,
          get() {
            getterCalls += 1;
            throw new Error("getter executed");
          },
        },
      },
    );
    const array: unknown[] = [];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("array getter executed");
      },
    });

    expect(snapshotData(object)).toEqual({ kept: 1 });
    expect(snapshotData(array)).toBeUndefined();
    expect(getterCalls).toBe(0);
  });

  test("contains throwing proxies and snapshots each record root once", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy trap executed");
        },
      },
    );
    let ownKeyCalls = 0;
    const counted = new Proxy(
      { value: 1 },
      {
        ownKeys(target) {
          ownKeyCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    expect(() => snapshotData(hostile)).not.toThrow();
    expect(snapshotData(hostile)).toBeUndefined();
    expect(snapshotDataRecord(counted)).toEqual({ value: 1 });
    expect(ownKeyCalls).toBe(1);
  });

  test("bounds object entries, array entries, and recursive depth", () => {
    const largeRecord = Object.fromEntries(
      Array.from({ length: SAFE_DATA_MAX_ENTRIES + 20 }, (_, index) => [`key${index}`, index]),
    );
    const largeArray = Array.from({ length: SAFE_DATA_MAX_ENTRIES + 20 }, (_, index) => index);
    let deep: DeepFixture = { leaf: "outside the depth bound" };
    for (let depth = 0; depth < SAFE_DATA_MAX_DEPTH; depth += 1) {
      deep = { child: deep };
    }

    expect(Object.keys(snapshotDataRecord(largeRecord) ?? {})).toHaveLength(SAFE_DATA_MAX_ENTRIES);
    expect(snapshotData(largeArray)).toHaveLength(SAFE_DATA_MAX_ENTRIES);
    expect(JSON.stringify(snapshotData(deep))).not.toContain("outside the depth bound");
  });

  test("normalizes holes and unsupported array values and breaks cycles within the bounds", () => {
    const cyclicObject: CyclicObjectFixture = {};
    cyclicObject.self = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    const sparse: unknown[] = [];
    sparse.length = 4;
    sparse[0] = 1;
    sparse[2] = Number.NaN;
    sparse[3] = cyclicArray;

    const sparseSnapshot = snapshotData(sparse);
    expect(Array.isArray(sparseSnapshot) ? sparseSnapshot.slice(0, 3) : sparseSnapshot).toEqual([
      1,
      null,
      null,
    ]);
    expect(() => JSON.stringify(snapshotData(cyclicObject))).not.toThrow();
    expect(() => JSON.stringify(snapshotData(cyclicArray))).not.toThrow();
  });

  test("copies only own properties to an ordinary root without __proto__ mutation", () => {
    const prototype = { inherited: "not copied" };
    const input = Object.create(prototype, {
      own: {
        value: "copied",
        enumerable: true,
        configurable: true,
        writable: true,
      },
      ["__proto__"]: {
        value: { polluted: true },
        enumerable: true,
        configurable: true,
        writable: true,
      },
    });

    const generic = snapshotData(input);
    const record = snapshotDataRecord(input);

    expect(Object.getPrototypeOf(generic)).toBeNull();
    expect(record).toBeDefined();
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.keys(record ?? {})).toEqual(["own", "__proto__"]);
    expect(record).not.toHaveProperty("inherited");
    expect(record?.["__proto__"]).toEqual({ polluted: true });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
