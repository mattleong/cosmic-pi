import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";

// Standard-library value types: Date, RegExp, Map, Set. Programs use them as ordinary JS;
// intra-sandbox checkpoints (Object.* helpers, spread, coercion inputs) preserve the live
// values, while at the host boundary (final result, tool arguments, JSON.stringify) they
// serialize exactly as JSON.stringify would: Date -> ISO string (invalid -> null),
// URL -> href, and RegExp/Map/Set/URLSearchParams -> {}.
const run = (code: string) => CodeMode.execute({ code, tools: {} });
const value = (code: string) =>
  Effect.map(run(code), (result) => {
    if (!result.ok)
      throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`);
    return result.value;
  });
const error = (code: string) =>
  Effect.map(run(code), (result) => {
    if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`);
    return result.error;
  });

describe("Date", () => {
  it.effect("Date.now() reads the guest wall clock, not the Effect test clock", () =>
    Effect.gen(function* () {
      expect(yield* value(`return typeof Date.now()`)).toBe("number");
      expect(yield* value(`return Date.now()`)).toBeGreaterThan(1_000_000_000_000);
    }),
  );

  it.effect("epoch construction and ISO rendering", () =>
    Effect.gen(function* () {
      expect(yield* value(`return new Date(0).toISOString()`)).toBe("1970-01-01T00:00:00.000Z");
    }),
  );

  it.effect("string parsing round-trips", () =>
    Effect.gen(function* () {
      expect(yield* value(`return new Date("2024-01-02T03:04:05.000Z").getTime()`)).toBe(
        1704164645000,
      );
      expect(yield* value(`return Date.parse("2024-01-02T03:04:05.000Z")`)).toBe(1704164645000);
    }),
  );

  it.effect("date arithmetic and comparison use the time value", () =>
    Effect.gen(function* () {
      expect(yield* value(`const a = new Date(1000); const b = new Date(3000); return b - a`)).toBe(
        2000,
      );
      expect(yield* value(`const a = new Date(1000); const b = new Date(3000); return a < b`)).toBe(
        true,
      );
      expect(yield* value(`return +new Date(42)`)).toBe(42);
    }),
  );

  it.effect("UTC getters read calendar components", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `const d = new Date("2024-03-05T06:07:08.009Z"); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]`,
        ),
      ).toEqual([2024, 2, 5, 6, 7, 8, 9]);
    }),
  );

  it.effect("invalid dates yield NaN times, guardable in-sandbox", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Number.isNaN(new Date("garbage").getTime())`)).toBe(true);
      expect(yield* value(`return new Date("garbage").toJSON()`)).toBeNull();
    }),
  );

  it.effect("toISOString on an invalid date is a catchable error", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `try { new Date("garbage").toISOString(); return "no" } catch { return "caught" }`,
        ),
      ).toBe("caught");
    }),
  );

  it.effect("template interpolation renders the ISO form", () =>
    Effect.gen(function* () {
      expect(yield* value("return `at ${new Date(0)}`")).toBe("at 1970-01-01T00:00:00.000Z");
    }),
  );

  it.effect("dates serialize to ISO strings at the boundary, direct and nested", () =>
    Effect.gen(function* () {
      expect(yield* value(`return new Date(0)`)).toBe("1970-01-01T00:00:00.000Z");
      expect(yield* value(`return { when: new Date(0), tags: [new Date(1000)] }`)).toEqual({
        when: "1970-01-01T00:00:00.000Z",
        tags: ["1970-01-01T00:00:01.000Z"],
      });
      expect(yield* value(`return JSON.stringify({ d: new Date(0) })`)).toBe(
        '{"d":"1970-01-01T00:00:00.000Z"}',
      );
    }),
  );

  it.effect("coercions: Number is the time, String is ISO, Boolean is true", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Number(new Date(5))`)).toBe(5);
      expect(yield* value(`return String(new Date(0))`)).toBe("1970-01-01T00:00:00.000Z");
      expect(yield* value(`return Boolean(new Date(0))`)).toBe(true);
    }),
  );

  it.effect("sorting dates with a numeric comparator", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const dates = [new Date(3000), new Date(1000), new Date(2000)]
      return dates.sort((a, b) => a - b).map((d) => d.getTime())
    `),
      ).toEqual([1000, 2000, 3000]);
    }),
  );

  it.effect("new Date(year, month, day) accepts component form", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `const d = new Date(2024, 0, 2); return [d.getFullYear(), d.getMonth(), d.getDate()]`,
        ),
      ).toEqual([2024, 0, 2]);
      expect(yield* value(`return new Date(24, 0, 2).getFullYear()`)).toBe(1924);
      expect(yield* value(`return new Date(-0.9, 0, 1).getFullYear()`)).toBe(1900);
      expect(yield* value(`return new Date(99.9, 0, 1).getFullYear()`)).toBe(1999);
    }),
  );

  it.effect("typeof and unknown properties are forgiving", () =>
    Effect.gen(function* () {
      expect(yield* value(`return typeof new Date(0)`)).toBe("object");
      expect(yield* value(`return new Date(0).nope === undefined`)).toBe(true);
    }),
  );
});

describe("RegExp", () => {
  it.effect("literal test", () =>
    Effect.gen(function* () {
      expect(yield* value(`return /ab+c/.test("xabbbc")`)).toBe(true);
      expect(yield* value(`return /ab+c/.test("nope")`)).toBe(false);
    }),
  );

  it.effect("exec exposes captures and index", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `const m = /a(b+)/.exec("xxabbc"); return { full: m[0], group: m[1], index: m.index }`,
        ),
      ).toEqual({
        full: "abb",
        group: "bb",
        index: 2,
      });
      expect(yield* value(`return /a/.exec("zzz")`)).toBeNull();
    }),
  );

  it.effect("named groups read through", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `const m = /(?<word>[a-z]+)-(?<num>\\d+)/.exec("id ab-42"); return m.groups.word + m.groups.num`,
        ),
      ).toBe("ab42");
    }),
  );

  it.effect("global exec advances lastIndex across calls", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const r = /\\d+/g
      const first = r.exec("a1b22c")
      const second = r.exec("a1b22c")
      return [first[0], second[0]]
    `),
      ).toEqual(["1", "22"]);
    }),
  );

  it.effect("string match: non-global carries index, global lists all matches", () =>
    Effect.gen(function* () {
      expect(yield* value(`const m = "a1b22".match(/\\d+/); return [m[0], m.index]`)).toEqual([
        "1",
        1,
      ]);
      expect(yield* value(`return "a1b22".match(/\\d+/g)`)).toEqual(["1", "22"]);
      expect(yield* value(`return "abc".match(/\\d/)`)).toBeNull();
    }),
  );

  it.effect("matchAll materializes match arrays with captures", () =>
    Effect.gen(function* () {
      expect(yield* value(`return "a1b22".matchAll(/(\\d+)/g).map((m) => m[1])`)).toEqual([
        "1",
        "22",
      ]);
    }),
  );

  it.effect("replace and replaceAll with patterns and $1 substitution", () =>
    Effect.gen(function* () {
      expect(yield* value(`return "a1b2".replace(/\\d/, "#")`)).toBe("a#b2");
      expect(yield* value(`return "a1b2".replace(/\\d/g, "#")`)).toBe("a#b#");
      expect(yield* value(`return "a1b2".replaceAll(/\\d/g, "#")`)).toBe("a#b#");
      expect(yield* value(`return "hi bob".replace(/b(o)b/, "[$1]")`)).toBe("hi [o]");
    }),
  );

  it.effect("function replacers receive captures, offsets, input, and named groups", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
        const seen = []
        const output = "a1b22".replace(/(\\d)(\\d)?/g, (match, first, second, offset, input) => {
          seen.push([match, first, second === undefined, offset, input])
          return Number(match) * 2
        })
        return { output, seen }
      `),
      ).toEqual({
        output: "a2b44",
        seen: [
          ["1", "1", true, 1, "a1b22"],
          ["22", "2", false, 3, "a1b22"],
        ],
      });
      expect(
        yield* value(`
        return "red-blue".replace(
          /(?<left>[a-z]+)-(?<right>[a-z]+)/,
          (match, left, right, offset, input, groups) => groups.right + ":" + groups.left,
        )
      `),
      ).toBe("blue:red");
    }),
  );

  it.effect(
    "function replacers support string searches, zero-length matches, and result coercion",
    () =>
      Effect.gen(function* () {
        expect(
          yield* value(
            `return "banana".replace("na", (match, offset, input) => "[" + offset + "]")`,
          ),
        ).toBe("ba[2]na");
        expect(yield* value(`return "ab".replaceAll("", (match, offset) => offset)`)).toBe("0a1b2");
        expect(
          yield* value(`return "😀".replaceAll(/(?:)/gu, (match, offset) => "[" + offset + "]")`),
        ).toBe("[0]😀[2]");
        expect(
          yield* value(
            `return "123".replace(/\\d/g, (match) => match === "1" ? 7 : match === "2" ? null : { n: 3 })`,
          ),
        ).toBe("7null[object Object]");
      }),
  );

  it.effect("function replacers can await effectful tool calls", () =>
    Effect.gen(function* () {
      const decorate = Tool.make({
        description: "Decorate a string",
        input: Schema.String,
        output: Schema.String,
        run: (input) => Effect.succeed(`[${input}]`),
      });
      const result = yield* CodeMode.execute({
        tools: { host: { decorate } },
        code: `return "a1b22".replace(/\\d+/g, async (match) => await tools.host.decorate(match))`,
      });
      expect(result.ok && result.value).toBe("a[1]b[22]");

      const missingAwait = yield* CodeMode.execute({
        tools: { host: { decorate } },
        code: `return "a1".replace(/\\d/, (match) => tools.host.decorate(match))`,
      });
      expect(!missingAwait.ok && missingAwait.error.kind).toBe("InvalidDataValue");
      expect(!missingAwait.ok && missingAwait.error.message).toContain("un-awaited Promise");
    }),
  );

  it.effect("replaceAll without the g flag is a catchable error", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`try { "a".replaceAll(/a/, "b"); return "no" } catch { return "caught" }`),
      ).toBe("caught");
    }),
  );

  it.effect("split and search accept patterns", () =>
    Effect.gen(function* () {
      expect(yield* value(`return "a1b22c".split(/\\d+/)`)).toEqual(["a", "b", "c"]);
      expect(yield* value(`return "ab42".search(/\\d/)`)).toBe(2);
      expect(yield* value(`return "ab".search(/\\d/)`)).toBe(-1);
    }),
  );

  it.effect("new RegExp constructs from strings; invalid patterns are catchable", () =>
    Effect.gen(function* () {
      expect(yield* value(`return new RegExp("a+", "i").test("AAA")`)).toBe(true);
      expect(yield* value(`try { new RegExp("("); return "no" } catch { return "caught" }`)).toBe(
        "caught",
      );
      expect(yield* value(`return [/a/ instanceof RegExp, /a/.source]`)).toEqual([true, "a"]);
    }),
  );

  it.effect("invalid patterns fail with actionable messages", () =>
    Effect.gen(function* () {
      const fromString = yield* error(`return "abc".match("(")`);
      expect(fromString.message).toContain('String.match received the string "("');
      expect(fromString.message).toContain("escape them with a backslash");

      const fromConstructor = yield* error(`return new RegExp("(")`);
      expect(fromConstructor.message).toContain('new RegExp(...) received "("');
      expect(fromConstructor.message).toContain("escape them with a backslash");

      const fromFlags = yield* error(`return new RegExp("a", "xz")`);
      expect(fromFlags.message).toContain('invalid flags "xz"');
      expect(fromFlags.message).toContain("Valid flags are");
    }),
  );

  it.effect("missing g-flag errors say how to fix the call", () =>
    Effect.gen(function* () {
      expect((yield* error(`return "aa".replaceAll(/a/, "b")`)).message).toContain(
        "write /a/g, or use String.replace",
      );
      expect((yield* error(`return "aa".matchAll(/a/)`)).message).toContain(
        "write /a/g, or use String.match",
      );
    }),
  );

  it.effect("a non-pattern argument names the expected shapes", () =>
    Effect.gen(function* () {
      const err = yield* error(`return "abc".match(42)`);
      expect(err.message).toContain("expects a regular expression");
      expect(err.message).toContain("not number");
    }),
  );

  it.effect("source and flags properties read through", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `const r = /ab/gi; return { source: r.source, flags: r.flags, global: r.global }`,
        ),
      ).toEqual({
        source: "ab",
        flags: "gi",
        global: true,
      });
    }),
  );

  it.effect("regexes serialize to {} at the boundary, like JSON", () =>
    Effect.gen(function* () {
      expect(yield* value(`return /a/`)).toEqual({});
      expect(yield* value(`return JSON.stringify({ r: /a/g })`)).toBe('{"r":{}}');
    }),
  );

  it.effect("template interpolation renders the literal form", () =>
    Effect.gen(function* () {
      expect(yield* value("return `${/ab/g}`")).toBe("/ab/g");
    }),
  );
});

describe("URL and URI helpers", () => {
  it.effect("encodes and decodes complete URIs and URI components", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
        return [
          encodeURI("https://example.test/a b?q=a/b"),
          encodeURIComponent("a b/c?"),
          decodeURI("https://example.test/a%20b?q=a/b"),
          decodeURIComponent("a%20b%2Fc%3F"),
          ["a b", "c/d"].map(encodeURIComponent),
        ]
      `),
      ).toEqual([
        "https://example.test/a%20b?q=a/b",
        "a%20b%2Fc%3F",
        "https://example.test/a b?q=a/b",
        "a b/c?",
        ["a%20b", "c%2Fd"],
      ]);
      expect(
        yield* value(
          `try { decodeURIComponent("%zz"); return false } catch (error) { return error instanceof URIError }`,
        ),
      ).toBe(true);
    }),
  );

  it.effect("resolves and mutates URLs with linked search parameters", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
        const url = new URL("../users?id=old#top", "https://user:pass@example.com:8443/api/v1/")
        url.pathname = "/items/a b"
        url.searchParams.set("id", "a b")
        url.searchParams.append("tag", "x/y")
        url.hash = "part 1"
        return {
          href: url.href,
          origin: url.origin,
          host: url.host,
          pathname: url.pathname,
          search: url.search,
          id: url.searchParams.get("id"),
          string: String(url),
          json: url.toJSON(),
          instances: [
            url instanceof URL,
            url.searchParams instanceof URLSearchParams,
            url.searchParams === url.searchParams,
          ],
        }
      `),
      ).toEqual({
        href: "https://user:pass@example.com:8443/items/a%20b?id=a+b&tag=x%2Fy#part%201",
        origin: "https://example.com:8443",
        host: "example.com:8443",
        pathname: "/items/a%20b",
        search: "?id=a+b&tag=x%2Fy",
        id: "a b",
        string: "https://user:pass@example.com:8443/items/a%20b?id=a+b&tag=x%2Fy#part%201",
        json: "https://user:pass@example.com:8443/items/a%20b?id=a+b&tag=x%2Fy#part%201",
        instances: [true, true, true],
      });
    }),
  );

  it.effect(
    "URLSearchParams supports records, pairs, mutation, callbacks, and materialization",
    () =>
      Effect.gen(function* () {
        expect(
          yield* value(`
        const params = new URLSearchParams([["tag", "b"], ["tag", "a"], ["q", "a b"]])
        const seen = []
        params.forEach((value, key) => seen.push(key + "=" + value))
        params.delete("tag", "b")
        params.append("tag", "c")
        params.sort()
        return {
          text: params.toString(),
          size: params.size,
          tags: params.getAll("tag"),
          has: params.has("tag", "c"),
          entries: Array.from(params),
          object: Object.fromEntries(params),
          record: new URLSearchParams({ page: 2, filter: "open" }).toString(),
          seen,
        }
      `),
        ).toEqual({
          text: "q=a+b&tag=a&tag=c",
          size: 3,
          tags: ["a", "c"],
          has: true,
          entries: [
            ["q", "a b"],
            ["tag", "a"],
            ["tag", "c"],
          ],
          object: { q: "a b", tag: "c" },
          record: "page=2&filter=open",
          seen: ["tag=b", "tag=a", "q=a b"],
        });
      }),
  );

  it.effect("URL parsing failures are catchable and values use native JSON forms", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
        const parsed = URL.parse("/users", "https://example.test/api/")
        let invalidIsTypeError = false
        try { new URL("not relative without a base") } catch (error) { invalidIsTypeError = error instanceof TypeError }
        return {
          canParse: URL.canParse("/users", "https://example.test/api/"),
          cannotParse: URL.canParse("not relative without a base"),
          parsed: parsed.href,
          invalidIsTypeError,
          boundary: [new URL("https://example.test/a"), new URLSearchParams("q=one")],
          json: JSON.stringify({ url: new URL("https://example.test/a"), params: new URLSearchParams("q=one") }),
        }
      `),
      ).toEqual({
        canParse: true,
        cannotParse: false,
        parsed: "https://example.test/users",
        invalidIsTypeError: true,
        boundary: ["https://example.test/a", {}],
        json: '{"url":"https://example.test/a","params":{}}',
      });
    }),
  );

  it.effect("distinguishes omitted URL arguments from explicit undefined", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
        function throwsTypeError(run) {
          try { run(); return false } catch (error) { return error instanceof TypeError }
        }
        const params = new URLSearchParams()
        const required = [
          () => params.append(),
          () => params.delete(),
          () => params.get(),
          () => params.getAll(),
          () => params.has(),
          () => params.set(),
          () => params.forEach(),
        ].map(throwsTypeError)
        params.append(undefined, undefined)
        return {
          construct: throwsTypeError(() => new URL()),
          canParse: throwsTypeError(() => URL.canParse()),
          parse: throwsTypeError(() => URL.parse()),
          explicitUndefined: new URL(undefined, "https://example.test/base/").href,
          params: params.toString(),
          required,
        }
      `),
      ).toEqual({
        construct: true,
        canParse: true,
        parse: true,
        explicitUndefined: "https://example.test/base/undefined",
        params: "undefined=undefined",
        required: [true, true, true, true, true, true, true],
      });
    }),
  );
});

describe("Map", () => {
  it.effect("get/set/has/size with chaining", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const m = new Map()
      m.set("a", 1).set("b", 2)
      return { a: m.get("a"), b: m.get("b"), has: m.has("a"), miss: m.get("zz") === undefined, size: m.size }
    `),
      ).toEqual({ a: 1, b: 2, has: true, miss: true, size: 5 - 3 });
    }),
  );

  it.effect("object keys use identity", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const key = { id: 1 }
      const m = new Map()
      m.set(key, "hit")
      return [m.get(key), m.get({ id: 1 }) === undefined]
    `),
      ).toEqual(["hit", true]);
    }),
  );

  it.effect("construction from entry pairs and another Map", () =>
    Effect.gen(function* () {
      expect(yield* value(`const m = new Map([["a", 1], ["b", 2]]); return m.get("b")`)).toBe(2);
      expect(
        yield* value(
          `const m = new Map([["a", 1]]); const n = new Map(m); n.set("b", 2); return [n.get("a"), n.get("b"), m.has("b")]`,
        ),
      ).toEqual([1, 2, false]);
      expect((yield* error(`return new Map("nope")`)).message).toMatch(/\[key, value\] pairs/);
      expect((yield* error(`return new Map(["flat"])`)).message).toMatch(/\[key, value\] pairs/);
    }),
  );

  it.effect("keys/values/entries return arrays", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const m = new Map([["a", 1], ["b", 2]])
      return { keys: m.keys(), values: m.values(), entries: m.entries() }
    `),
      ).toEqual({
        keys: ["a", "b"],
        values: [1, 2],
        entries: [
          ["a", 1],
          ["b", 2],
        ],
      });
    }),
  );

  it.effect("Object.fromEntries(map) and Array.from(map)", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.fromEntries(new Map([["a", 1], ["b", 2]]))`)).toEqual({
        a: 1,
        b: 2,
      });
      expect(yield* value(`return Array.from(new Map([["a", 1]]))`)).toEqual([["a", 1]]);
    }),
  );

  it.effect("for...of iterates [key, value] pairs with destructuring", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const m = new Map([["a", 1], ["b", 2]])
      let total = 0
      let names = ""
      for (const [key, count] of m) { names += key; total += count }
      return names + total
    `),
      ).toBe("ab3");
    }),
  );

  it.effect("spread produces entry pairs", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [...new Map([["a", 1]])]`)).toEqual([["a", 1]]);
    }),
  );

  it.effect("forEach passes (value, key)", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const m = new Map([["a", 1], ["b", 2]])
      const seen = []
      m.forEach((count, key) => seen.push(key + count))
      return seen
    `),
      ).toEqual(["a1", "b2"]);
    }),
  );

  it.effect("delete and clear", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const m = new Map([["a", 1], ["b", 2]])
      const removed = m.delete("a")
      const missed = m.delete("zz")
      const sizeAfterDelete = m.size
      m.clear()
      return [removed, missed, sizeAfterDelete, m.size]
    `),
      ).toEqual([true, false, 1, 0]);
    }),
  );

  it.effect("counting idiom: grouped tallies", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const words = ["a", "b", "a", "c", "a"]
      const counts = new Map()
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
      return Object.fromEntries(counts)
    `),
      ).toEqual({ a: 3, b: 1, c: 1 });
    }),
  );

  it.effect("maps serialize to {} at the boundary, like JSON", () =>
    Effect.gen(function* () {
      expect(yield* value(`return new Map([["a", 1]])`)).toEqual({});
      expect(yield* value(`return JSON.stringify(new Map([["a", 1]]))`)).toBe("{}");
    }),
  );

  it.effect("console.log renders map contents for debugging", () =>
    Effect.gen(function* () {
      const result = yield* run(`console.log(new Map([["a", 1]])); return null`);
      expect(result.ok).toBe(true);
      expect(result.logs?.[0]).toBe(`Map(1) [["a",1]]`);
    }),
  );
});

describe("Set", () => {
  it.effect("add/has/delete/size with chaining", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const s = new Set()
      s.add(1).add(2).add(1)
      const removed = s.delete(2)
      return [s.size, s.has(1), s.has(2), removed]
    `),
      ).toEqual([1, true, false, true]);
    }),
  );

  it.effect("dedupe idiom: [...new Set(items)]", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [...new Set([1, 2, 2, 3, 1])]`)).toEqual([1, 2, 3]);
    }),
  );

  it.effect("construction from strings and other Sets", () =>
    Effect.gen(function* () {
      expect(yield* value(`return [...new Set("aba")]`)).toEqual(["a", "b"]);
      expect(yield* value(`return Array.from(new Set(new Set([1, 2])))`)).toEqual([1, 2]);
    }),
  );

  it.effect("SameValueZero: NaN is findable", () =>
    Effect.gen(function* () {
      expect(yield* value(`const s = new Set([NaN]); return s.has(NaN)`)).toBe(true);
    }),
  );

  it.effect("for...of iterates values", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      let total = 0
      for (const n of new Set([1, 2, 3])) total += n
      return total
    `),
      ).toBe(6);
    }),
  );

  it.effect("sets serialize to {} at the boundary, like JSON", () =>
    Effect.gen(function* () {
      expect(yield* value(`return { s: new Set([1]) }`)).toEqual({ s: {} });
    }),
  );
});

describe("stdlib integration", () => {
  it.effect("typeof reports constructors as functions and never throws", () =>
    Effect.gen(function* () {
      expect(yield* value(`return typeof Map`)).toBe("function");
      expect(yield* value(`return typeof ((x) => x)`)).toBe("function");
      expect(yield* value(`return typeof Math`)).toBe("object");
      expect(yield* value(`return typeof tools`)).toBe("object");
    }),
  );

  it.effect("negation works on any value", () =>
    Effect.gen(function* () {
      expect(yield* value(`return !new Map()`)).toBe(false);
      expect(yield* value(`const fn = () => 1; return !fn`)).toBe(false);
    }),
  );

  it.effect("object spread of sandbox values is a no-op, like JS", () =>
    Effect.gen(function* () {
      expect(yield* value(`return { ...new Map([["a", 1]]), kept: true }`)).toEqual({ kept: true });
    }),
  );

  it.effect("dates inside Map values survive in-sandbox reads", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const m = new Map([["start", new Date(1000)]])
      return m.get("start").getTime()
    `),
      ).toBe(1000);
    }),
  );

  it.effect("instanceof recognizes the stdlib value types", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `return [new Date(0) instanceof Date, /a/ instanceof RegExp, new Map() instanceof Map, new Set() instanceof Set]`,
        ),
      ).toEqual([true, true, true, true]);
      expect(
        yield* value(
          `return [[1] instanceof Array, [1] instanceof Object, ({}) instanceof Object, 5 instanceof Object]`,
        ),
      ).toEqual([true, true, true, false]);
      expect(yield* value(`return [new Map() instanceof Set, "s" instanceof Date]`)).toEqual([
        false,
        false,
      ]);
      expect(
        yield* value(
          `const p = Promise.resolve(1); const isPromise = p instanceof Promise; await p; return isPromise`,
        ),
      ).toBe(true);
    }),
  );

  it.effect("realistic pipeline: parse, extract with regex, dedupe, count by day", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const raw = '[{"at":"2024-01-01T05:00:00Z","tag":"a b"},{"at":"2024-01-01T09:00:00Z","tag":"b c"},{"at":"2024-01-02T01:00:00Z","tag":"a"}]'
      const rows = JSON.parse(raw)
      const tags = new Set()
      const byDay = new Map()
      for (const row of rows) {
        for (const m of row.tag.matchAll(/[a-z]+/g)) tags.add(m[0])
        const day = new Date(row.at).toISOString().slice(0, 10)
        byDay.set(day, (byDay.get(day) ?? 0) + 1)
      }
      return { tags: [...tags].sort((a, b) => (a < b ? -1 : 1)), byDay: Object.fromEntries(byDay) }
    `),
      ).toEqual({ tags: ["a", "b", "c"], byDay: { "2024-01-01": 2, "2024-01-02": 1 } });
    }),
  );
});

describe("sandbox values at intra-sandbox checkpoints", () => {
  it.effect("Object.values/entries keep Dates usable", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.values({ d: new Date(0) })[0].getTime()`)).toBe(0);
      expect(
        yield* value(
          `const [key, d] = Object.entries({ d: new Date(0) })[0]; return key + ":" + d.getTime()`,
        ),
      ).toBe("d:0");
    }),
  );

  it.effect("Object.assign keeps Maps usable", () =>
    Effect.gen(function* () {
      expect(
        yield* value(
          `const merged = Object.assign({}, { m: new Map([["a", 1]]) }); return merged.m.get("a")`,
        ),
      ).toBe(1);
    }),
  );

  it.effect("object and array spread keep sandbox values usable", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`
      const src = { m: new Map([["a", 1]]) }
      const copy = { ...src }
      copy.m.set("b", 2)
      return [copy.m.get("a"), src.m.get("b")]
    `),
      ).toEqual([1, 2]);
      expect(
        yield* value(
          `const list = [new Date(1000)]; const copy = [...list]; return copy[0].getTime()`,
        ),
      ).toBe(1000);
    }),
  );

  it.effect("Array.from over arrays keeps nested sandbox values usable", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Array.from([new Date(5)])[0].getTime()`)).toBe(5);
    }),
  );

  it.effect("regexes stay callable through Object.values", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.values({ r: /ab+/ })[0].test("abb")`)).toBe(true);
    }),
  );

  it.effect("Object.* helpers see sandbox values as empty objects, never internals", () =>
    Effect.gen(function* () {
      expect(yield* value(`return Object.keys(new Map([["a", 1]]))`)).toEqual([]);
      expect(yield* value(`return Object.values(new Date(0))`)).toEqual([]);
      expect(yield* value(`return Object.entries(new Set([1]))`)).toEqual([]);
      expect(yield* value(`return Object.assign({}, new Map([["a", 1]]))`)).toEqual({});
      expect(yield* value(`return Object.hasOwn(new Date(0), "time")`)).toBe(false);
    }),
  );

  it.effect(
    "the host boundary still serializes JSON forms: results, JSON.stringify, and tool arguments",
    () =>
      Effect.gen(function* () {
        expect(yield* value(`return { d: new Date(0), m: new Map([["a", 1]]) }`)).toEqual({
          d: "1970-01-01T00:00:00.000Z",
          m: {},
        });
        expect(yield* value(`return JSON.stringify({ d: new Date(0) })`)).toBe(
          '{"d":"1970-01-01T00:00:00.000Z"}',
        );

        const observed: Array<unknown> = [];
        const capture = Tool.make({
          description: "Capture the exact input the host receives",
          input: { type: "object" },
          run: (input) =>
            Effect.sync(() => {
              observed.push(input);
              return "ok";
            }),
        });
        const result = yield* CodeMode.execute({
          tools: { host: { capture } },
          code: `return await tools.host.capture({ when: new Date(0), tags: new Map([["a", 1]]) })`,
        });
        expect(result.ok).toBe(true);
        expect(observed).toStrictEqual([{ when: "1970-01-01T00:00:00.000Z", tags: {} }]);
      }),
  );
});
