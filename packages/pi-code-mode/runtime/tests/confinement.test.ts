// Local confinement suite (not vendored from upstream; see PROVENANCE.md): hostile regex
// refusal, amplification limits, collection growth, JSON/log growth, and wall-clock timeout
// normalization. Every hostile case asserts *fast* refusal - the point of the confinement
// layer is that no admitted native operation can block the event loop for seconds.
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CodeMode, Tool } from "../src/index.js";
import type { InterpreterValue } from "../src/interpreter/model.js";
import { hostDate } from "../src/stdlib/epoch.js";
import {
  containsOpaqueReference,
  containsRuntimeReference,
} from "../src/interpreter/references.js";
import {
  MAX_GUEST_COLLECTION_ENTRIES,
  MAX_GUEST_STRING_LENGTH,
  MAX_LOG_ENTRIES,
  MAX_LOG_ENTRY_LENGTH,
} from "../src/interpreter/confinement.js";
import { regexSubjectCap } from "../src/interpreter/regex-guard.js";
import { setDeadlineClockForTesting } from "../src/interpreter/deadline.js";
import { copyIn, copyOut } from "../src/tool-runtime-data.js";

const run = (code: string, limits?: CodeMode.ExecutionLimits) =>
  CodeMode.execute(limits ? { code, limits } : { code });

const failure = (code: string, limits?: CodeMode.ExecutionLimits) =>
  Effect.map(run(code, limits), (result) => {
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    return result.error;
  });

/** Asserts the program settles fast - hostile inputs must be refused, not endured. */
const timed = <A, E>(work: () => Effect.Effect<A, E>, maxMs = 1_500): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const value = yield* work();
    const endedAt = yield* Clock.currentTimeMillis;
    expect(endedAt - startedAt).toBeLessThan(maxMs);
    return value;
  });

/**
 * Admission exactly at a collection cap does real work proportional to the cap, so its bound
 * guards against hangs rather than measuring refusal latency, and tolerates a loaded machine.
 */
const ADMITTED_AT_CAP_MS = 10_000;

describe("regex confinement: hostile patterns are refused fast", () => {
  it.live("the audit repro /(a+)+$/ is rejected at construction, not executed for seconds", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`return /(a+)+$/.test("${"a".repeat(28)}!")`, { timeoutMs: 10_000 }),
      );
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("group that itself contains a quantifier");
    }),
  );

  it.live("nested quantifiers are rejected through every construction door", () =>
    Effect.gen(function* () {
      for (const code of [
        `return /(a+)+$/.test("aaa")`,
        `return new RegExp("(a+)+$").test("aaa")`,
        `return "aaa".match("(a+)+$")`,
        `return "aaa".split(/(a*)*b/)`,
        `return "aaa".replaceAll(/(a+)*b/g, "x")`,
      ]) {
        const error = yield* timed(() => failure(code));
        expect(error.kind).toBe("UnsupportedSyntax");
      }
    }),
  );

  it.live("alternation inside a repeated group is rejected (exponential family)", () =>
    Effect.gen(function* () {
      const error = yield* timed(() => failure(`return /(a|aa)+$/.test("${"a".repeat(24)}!")`));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("alternation");
      expect(error.message).toContain("character class");
    }),
  );

  it.effect("supports literal log filtering without relaxing ambiguous-regex confinement", () =>
    Effect.gen(function* () {
      const error = yield* failure('return /Test Files|Tests |Done/.test("Tests 12 passed");');
      expect(error.kind).toBe("UnsupportedSyntax");
      const result = yield* run(
        `
        const terms = ["Test Files", "Tests ", "Done"];
        const lines = ["starting", "Test Files 2 passed", "Tests 12 passed", "Done", "unrelated"];
        return lines.filter(line => terms.some(term => line.includes(term)));
      `,
        { maxOutputBytes: 256 },
      );
      expect(result).toMatchObject({
        ok: true,
        value: ["Test Files 2 passed", "Tests 12 passed", "Done"],
      });
    }),
  );

  it.live("backreferences and named backreferences are rejected", () =>
    Effect.gen(function* () {
      for (const code of [`return /(a)\\1/.test("aa")`, `return /(?<x>a)\\k<x>/.test("aa")`]) {
        const error = yield* timed(() => failure(code));
        expect(error.kind).toBe("UnsupportedSyntax");
        expect(error.message).toContain("backreference");
      }
    }),
  );

  it.live("quantified lookarounds, oversized bounds, and too many optionals are rejected", () =>
    Effect.gen(function* () {
      expect((yield* failure(`return /(?=a)+b/.test("ab")`)).kind).toBe("UnsupportedSyntax");
      expect((yield* failure(`return /a{1,500}/.test("a")`)).kind).toBe("UnsupportedSyntax");
      expect((yield* failure(`return /a?b?c?d?e?f?g?h?i?/.test("x")`)).kind).toBe(
        "UnsupportedSyntax",
      );
      expect((yield* failure(`return new RegExp("a".repeat(1200)).test("a")`)).kind).toBe(
        "UnsupportedSyntax",
      );
    }),
  );

  it.live("the polynomial-backtracking audit repro /a*a*a*a*a*a*b/ is rejected, not executed", () =>
    Effect.gen(function* () {
      // Six unbounded quantifiers can stall native matching for ~half a second on 44 characters.
      // A cooperative deadline cannot interrupt that work; the static screen must refuse it.
      const error = yield* timed(
        () => failure(`return /a*a*a*a*a*a*b/.test("a".repeat(44))`),
        1_000,
      );
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("unbounded quantifiers");
    }),
  );

  it.live("the polynomial family is rejected through every construction door", () =>
    Effect.gen(function* () {
      for (const code of [
        `return /a*a*a*a*b/.test("aaaa")`,
        `return new RegExp("a*a*a*a*b").test("aaaa")`,
        `return "aaaa".match("a*a*a*a*b")`,
        `return "aaaa".replaceAll(/a*a*a*a*b/g, "x")`,
        `return "aaaa".split(/a*a*a*a*b/)`,
        `return "aaaa".search(/a*a*a*a*b/)`,
        `return "aaaa".matchAll(/a*a*a*a*b/g)`,
        `return /a+a+a+a+b/.exec("aaaa")`,
        `return /a{1,}a{1,}a{1,}a{1,}b/.test("aaaa")`,
      ]) {
        const error = yield* timed(() => failure(code));
        expect(error.kind).toBe("UnsupportedSyntax");
        expect(error.message).toContain("unbounded quantifiers");
      }
    }),
  );

  it.live("subjects over the pattern's backtracking budget are refused with guidance", () =>
    Effect.gen(function* () {
      // One unbounded quantifier, unanchored: degree 2 -> 2048-character cap.
      const error = yield* timed(() =>
        failure(`return /x+y/.test("x".repeat(20000) + "z")`, { timeoutMs: 10_000 }),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("backtracking budget");
      expect(error.message).toContain("split('\\n')");
    }),
  );

  it.live("three admitted unbounded quantifiers get only the smallest subject cap", () =>
    Effect.gen(function* () {
      // /a*a*a*b/ passes the count screen (3 unbounded) but is degree 4 unanchored: only
      // subjects up to the 64-character cap are admitted, so its polynomial worst case stays
      // bounded to well under the strictest deadline granularity.
      const error = yield* timed(() => failure(`return /a*a*a*b/.test("a".repeat(65))`));
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("backtracking budget");
      const admitted = yield* timed(() => run(`return /a*a*a*b/.test("a".repeat(44))`));
      expect(admitted).toMatchObject({ ok: true, value: false });
    }),
  );

  it.live("optional quantifiers divide the admitted subject cap by their branch factor", () =>
    Effect.gen(function* () {
      // Eight optionals multiply a 256x branch factor into every match attempt: degree 1
      // anchored keeps the 262144 base cap, divided down to 1024 admitted characters.
      const pattern = `/^a?a?a?a?a?a?a?a?b/`;
      const error = yield* timed(() => failure(`return ${pattern}.test("a".repeat(2000))`));
      expect(error.kind).toBe("InvalidDataValue");
      const admitted = yield* timed(() => run(`return ${pattern}.test("a".repeat(500))`));
      expect(admitted).toMatchObject({ ok: true, value: false });
    }),
  );

  it.live("variable counted repetitions are charged as branch factor and rejected past it", () =>
    Effect.gen(function* () {
      // {0,200} contributes a 201-way branch; two of them multiply past the 256 factor cap.
      const error = yield* timed(() => failure(`return /a{0,200}a{0,200}b/.test("aaa")`));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("branch factor");
    }),
  );

  it.live("anchored single-quantifier patterns keep working on large subjects", () =>
    Effect.gen(function* () {
      const result = yield* timed(() => run(`return /^a+$/.test("a".repeat(100000))`));
      expect(result).toMatchObject({ ok: true, value: true });
    }),
  );

  it.live("everyday regex usage is preserved", () =>
    Effect.gen(function* () {
      const result = yield* timed(() =>
        run(`
        const text = "alpha=1 beta=22 gamma=333";
        const pairs = text.matchAll(/(?<key>[a-z]+)=(\\d+)/g).map((m) => m.groups.key + ":" + m[2]);
        const first = text.match(/[a-z]+/);
        const parts = "a1b22c".split(/\\d+/);
        const swapped = "red-blue".replace(/(red)-(blue)/, "$2-$1");
        return { pairs, first: first[0], parts, swapped, tested: /ab+c/.test("xabbc") };
      `),
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          pairs: ["alpha:1", "beta:22", "gamma:333"],
          first: "alpha",
          parts: ["a", "b", "c"],
          swapped: "blue-red",
          tested: true,
        },
      });
    }),
  );

  it.live("the ambiguous-alternation audit repro is rejected statically, never matched", () =>
    Effect.gen(function* () {
      // Twelve anchored (a|aa) groups can backtrack for ~400ms. The static screen must refuse
      // the pattern before matching because both branches can start on the same character.
      const groups = "(a|aa)".repeat(12);
      const error = yield* timed(
        () => failure(`return /^${groups}b$/.test("${"a".repeat(24)}")`),
        1_000,
      );
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("alternation branches can start with the same character");
    }),
  );

  it.live("ambiguous alternation is rejected through every construction and match door", () =>
    Effect.gen(function* () {
      for (const code of [
        `return /(a|ab)c/.test("abc")`,
        `return new RegExp("(a|ab)c").test("abc")`,
        `return "abc".match("(a|ab)c")`,
        `return "abc".split(/x(a|ab)/)`,
        `return "abc".replaceAll(/(a|ab)/g, "x")`,
        `return "abc".search(/(a|ab)c/)`,
        `return "abc".matchAll(/(a|ab)c/g)`,
        `return /(a|ab)c/.exec("abc")`,
        `return /a|ab/.test("abc")`,
      ]) {
        const error = yield* timed(() => failure(code));
        expect(error.kind).toBe("UnsupportedSyntax");
        expect(error.message).toContain("alternation");
      }
    }),
  );

  it.live("alternation ambiguity screen: nested, empty, escaped, and class variants", () =>
    Effect.gen(function* () {
      const rejected = [
        `/((a|b)|b)x/`, // nested group branch overlapping a sibling
        `/(a|)b/`, // empty branch can match without consuming
        `/(|a)b/`,
        `/(\\d|7)x/`, // escape class overlapping a literal
        `/([a-c]|b)x/`, // character class overlapping a literal
        `/([^a]|b)x/`, // negated class: starting set unknowable
        `/(.|a)x/`, // dot: starting set unknowable
        `/(a?b|c)x/`, // possibly-zero first quantifier: first character unknowable
        `/(a|A)x/i`, // case folding makes the branches overlap
      ];
      for (const pattern of rejected) {
        const error = yield* timed(() => failure(`return ${pattern}.test("abc")`));
        expect(error.kind).toBe("UnsupportedSyntax");
        expect(error.message).toContain("alternation");
      }
      // Adjacent disjoint alternatives stay admitted for everyday use.
      const admitted = yield* timed(() =>
        run(`
        return [
          /(foo|bar)/.test("xbar"),
          "a,b;c".split(/(,|;)/).length,
          /^(GET|head)$/i.test("GET"),
          /((a|b)x|cy)/.test("bx"),
          /(\\d|x)/.test("x7"),
          /(\\s|-)/.test("a b"),
          /([ab]|c)/.test("c"),
          /(a|A)/.test("A"),
          /(?=a|b)a/.test("a"),
        ];
      `),
      );
      expect(admitted).toMatchObject({
        ok: true,
        value: [true, 5, true, true, true, true, true, true, true],
      });
    }),
  );

  it.live(
    "inline flag-modifier groups are rejected through every construction and match door",
    () =>
      Effect.gen(function* () {
        // Current V8 accepts (?i:...) / (?ims-ims:...). The confinement scanner does not model
        // local flag semantics; without an explicit screen it would misread the prefix and admit
        // the ambiguous alternation inside (?i:a|aa). Every route must refuse the pattern
        // statically, before any native match runs.
        for (const code of [
          `return /(?i:a|aa)/.test("aa")`,
          `return new RegExp("(?i:a|aa)").test("aa")`,
          `return "aa".match("(?i:a|aa)")`,
          `return /(?i:a|aa)/.exec("aa")`,
          `return "aa".match(/(?i:a|aa)/)`,
          `return "aa".matchAll(/(?i:a|aa)/g)`,
          `return "aa".search(/(?i:a|aa)/)`,
          `return "aa".replace(/(?i:a|aa)/, "x")`,
          `return "aa".replaceAll(/(?i:a|aa)/g, "x")`,
          `return "aa".split(/(?i:a|aa)/)`,
        ]) {
          const error = yield* timed(() => failure(code, { timeoutMs: 10_000 }));
          expect(error.kind).toBe("UnsupportedSyntax");
          expect(error.message).toContain("inline flag-modifier group");
        }
      }),
  );

  it.live("the repeated modifier-group ambiguous-alternation family is rejected statically", () =>
    Effect.gen(function* () {
      // Twelve (?i:a|aa) groups are the (a|aa)(a|aa)...b audit family behind a modifier
      // prefix: admitted, this backtracks for hundreds of milliseconds.
      const groups = "(?i:a|aa)".repeat(12);
      const error = yield* timed(
        () => failure(`return /^${groups}b$/.test("${"a".repeat(24)}")`),
        1_000,
      );
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("inline flag-modifier group");
    }),
  );

  it.live(
    "every valid modifier-prefix shape is rejected; malformed ones keep syntax diagnostics",
    () =>
      Effect.gen(function* () {
        // All natively valid prefix shapes: add-only, multi-flag, add-remove, remove-only,
        // trailing dash, and nested placement.
        for (const pattern of [
          "(?i:a)",
          "(?ims:a)",
          "(?i-m:a)",
          "(?-i:a)",
          "(?i-:a)",
          "(?s:x)y",
          "x(?m:y)",
          "(?:a(?i:b))",
        ]) {
          const error = yield* timed(() =>
            failure(`return new RegExp(${JSON.stringify(pattern)}).test("a")`),
          );
          expect(error.kind).toBe("UnsupportedSyntax");
          expect(error.message).toContain("inline flag-modifier group");
        }
        // Malformed modifier-like groups never reach the screen: the native constructor rejects
        // them first and the normal guest-catchable SyntaxError diagnostic is preserved.
        const malformed = yield* timed(() =>
          run(`
        return ["(?ii:a)", "(?i-i:a)", "(?-:a)", "(?i)a", "(?x:a)"].map((pattern) => {
          try { new RegExp(pattern); return "constructed"; }
          catch (e) { return e instanceof SyntaxError && !e.message.includes("inline flag-modifier"); }
        });
      `),
        );
        expect(malformed).toMatchObject({ ok: true, value: [true, true, true, true, true] });
        // Noncapturing groups, lookarounds, and named groups stay admitted unchanged.
        const admitted = yield* timed(() =>
          run(`
        return [
          /(?:foo)bar/.test("foobar"),
          "iab".replace(/(?:i)(a)/, "$1"),
          /(?<name>a)b/.exec("ab").groups.name,
          /(?=a)a/.test("a"),
          /(?<=a)b/.test("ab"),
          /(?<!x)b/.test("ab"),
        ];
      `),
        );
        expect(admitted).toMatchObject({ ok: true, value: [true, "ab", "a", true, true, true] });
      }),
  );

  it.live("admitted disjoint alternations charge the combined branch factor", () =>
    Effect.gen(function* () {
      // Nine 2-branch alternations multiply a 512-way branch factor: over the 256 cap.
      const over = "(a|b)(c|d)(e|f)(g|h)(i|j)(k|l)(m|n)(o|p)(q|r)";
      const error = yield* timed(() => failure(`return /${over}/.test("aceg")`));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("branch factor");
      // Eight stay admitted (factor 256), with the subject cap divided accordingly.
      const eight = "(a|b)(c|d)(e|f)(g|h)(i|j)(k|l)(m|n)(o|p)";
      const admitted = yield* timed(() => run(`return /${eight}/.test("acegikmo")`));
      expect(admitted).toMatchObject({ ok: true, value: true });
      const capped = yield* timed(() => failure(`return /${eight}/.test("z".repeat(2000))`));
      expect(capped.kind).toBe("InvalidDataValue");
      expect(capped.message).toContain("backtracking budget");
    }),
  );

  it.live("a [^] class cannot hide quantifiers from the scanner (engine ] semantics)", () =>
    Effect.gen(function* () {
      // The engine closes [^] immediately, so the six quantifiers here are real pattern atoms
      // (the trailing ] is a literal); a class scan that treated the first ] as a literal
      // member would skip them all and admit the polynomial family at full subject caps.
      const error = yield* timed(() =>
        failure(`return /[^]a*a*a*a*a*a*b]/.test("${"a".repeat(44)}")`),
      );
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("unbounded quantifiers");
    }),
  );

  it("subject caps scale down with the pattern's residual degree and branch factor", () => {
    expect(regexSubjectCap(1)).toBe(262_144);
    expect(regexSubjectCap(2)).toBe(2_048);
    expect(regexSubjectCap(3)).toBe(128);
    expect(regexSubjectCap(4)).toBe(64);
    expect(regexSubjectCap(9)).toBe(64);
    expect(regexSubjectCap(1, 256)).toBe(1_024);
    expect(regexSubjectCap(2, 256)).toBe(16);
    expect(regexSubjectCap(4, 256)).toBe(16);
  });

  it.live("lookarounds are charged as unbounded work", () =>
    Effect.gen(function* () {
      // Four lookarounds exceed the unbounded budget outright.
      const rejected = yield* timed(() => failure(`return /(?=a)(?=b)(?=c)(?=d)x/.test("x")`));
      expect(rejected.kind).toBe("UnsupportedSyntax");
      // A single lookaround stays admitted for everyday validation patterns.
      const admitted = yield* timed(() => run(`return /^(?=.*x)[a-z]+$/.test("axb")`));
      expect(admitted).toMatchObject({ ok: true, value: true });
    }),
  );
});

describe("string amplification limits", () => {
  it.live("String.repeat over the cap is refused before allocation", () =>
    Effect.gen(function* () {
      const error = yield* timed(() => failure(`return "a".repeat(10_000_000)`));
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("String.repeat");
    }),
  );

  it.live("doubling concatenation is refused at the fixed cap, fast", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`let s = "a"; while (true) { s = s + s; } return s.length`, {
          timeoutMs: 30_000,
        }),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("String concatenation");
    }),
  );

  it.live("template literals, padStart, and concat are charged up front", () =>
    Effect.gen(function* () {
      const big = `const s = "x".repeat(${MAX_GUEST_STRING_LENGTH - 8})`;
      expect((yield* failure(`${big}; return \`--\${s}\${s}--\``)).kind).toBe("InvalidDataValue");
      expect((yield* failure(`return "x".padStart(100_000_000)`)).kind).toBe("InvalidDataValue");
      expect((yield* failure(`${big}; return s.concat(s)`)).kind).toBe("InvalidDataValue");
    }),
  );

  it.live("String(...) coercion of huge nested arrays is budgeted", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`const s = "x".repeat(2_000_000); return String([s, s, s]).length`),
      );
      expect(error.kind).toBe("InvalidDataValue");
    }),
  );

  it.live("global replace expansion is charged before the native call", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`return "${"a".repeat(64)}".replaceAll("a", "b".repeat(1_000_000)).length`),
      );
      expect(error.kind).toBe("InvalidDataValue");
    }),
  );

  it.live("replacement patterns that repeat the subject are charged as they expand", () =>
    Effect.gen(function* () {
      for (const code of [
        'return "a".repeat(30_000).replace(/a/g, "$`").length',
        'return "ab".repeat(15_000).replace(/a/g, "$\'").length',
        'return "a".repeat(30_000).replaceAll("", "$`").length',
        'return "a".repeat(3_000).replace(/(?:)/g, "$`$`$`$`").length',
      ]) {
        const error = yield* timed(() => failure(code));
        expect(error.kind).toBe("InvalidDataValue");
      }
    }),
  );

  it.live("case mapping and normalization charge their worst-case growth for non-ASCII text", () =>
    Effect.gen(function* () {
      for (const code of [
        'return "é".repeat(1_500_000).toUpperCase().length',
        'return "é".repeat(250_000).normalize("NFKC").length',
      ]) {
        const error = yield* timed(() => failure(code));
        expect(error.kind).toBe("InvalidDataValue");
      }
      expect(
        yield* run(
          'return ["a".repeat(4_000_000).toUpperCase().length, "é".repeat(1_000).normalize("NFD").length]',
        ),
      ).toMatchObject({ ok: true, value: [4_000_000, 2_000] });
    }),
  );

  it.live("a tool result over the string cap is refused at the data boundary", () =>
    Effect.gen(function* () {
      const oversized = Tool.make({
        description: "Return an oversized payload",
        input: Schema.Struct({}),
        output: Schema.String,
        run: () => Effect.succeed("x".repeat(MAX_GUEST_STRING_LENGTH + 1)),
      });
      const result = yield* CodeMode.execute({
        tools: { host: { oversized } },
        code: `return await tools.host.oversized({})`,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("InvalidToolOutput");
    }),
  );
});

describe("collection growth limits", () => {
  it.live("split results over the entry cap are refused", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1}).split("").length`),
      );
      expect(error.kind).toBe("InvalidDataValue");
    }),
  );

  it.live("sparse array index assignment cannot fabricate huge arrays", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`const a = [1]; a[1_000_000_000] = 2; return a.length`),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("Array assignment");
    }),
  );

  it.live("push, concat, splice, and flatMap growth is charged before mutation", () =>
    Effect.gen(function* () {
      const seed = `const a = "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split("")`;
      expect((yield* failure(`${seed}; a.push(1); return a.length`)).kind).toBe("InvalidDataValue");
      expect((yield* failure(`${seed}; return a.concat(a).length`)).kind).toBe("InvalidDataValue");
      expect((yield* failure(`${seed}; a.splice(0, 0, 1); return a.length`)).kind).toBe(
        "InvalidDataValue",
      );
      expect((yield* failure(`${seed}; return a.flatMap((x) => [x, x]).length`)).kind).toBe(
        "InvalidDataValue",
      );
    }),
  );

  it.live("array spread over the entry cap is refused", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(
          `const a = "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split(""); return [0, ...a].length`,
        ),
      );
      expect(error.kind).toBe("InvalidDataValue");
    }),
  );

  it.live("Array.from refuses a forged array-like length before any native allocation", () =>
    Effect.gen(function* () {
      // The guard must fire on the projected length alone: a billion-entry (or Infinity)
      // allocation would exhaust process memory if the native call ran first, so fast refusal
      // here is itself the evidence that nothing was allocated.
      for (const length of ["1_000_000_000", "Infinity", `${MAX_GUEST_COLLECTION_ENTRIES + 1}`]) {
        const error = yield* timed(
          () => failure(`return Array.from({ length: ${length} }).length`),
          1_000,
        );
        expect(error.kind).toBe("InvalidDataValue");
        expect(error.message).toContain("Array.from");
      }
      // ToLength semantics for admitted array-likes are preserved.
      const admitted = yield* run(
        `return [Array.from({ length: 2, 0: "a", 1: "b" }), Array.from({ length: -5 }), Array.from({ length: 2.9 }).length]`,
      );
      expect(admitted).toMatchObject({ ok: true, value: [["a", "b"], [], 2] });
    }),
  );

  it.live("Array.from of a string over the entry cap is refused before materialization", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`return Array.from("x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1})).length`),
      );
      expect(error.kind).toBe("InvalidDataValue");
      // for...of iterates the same string lazily and stays admitted.
      const iterated = yield* timed(() =>
        run(`for (const c of "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1})) { return c; }`),
      );
      expect(iterated).toMatchObject({ ok: true, value: "x" });
    }),
  );

  it.live("Array.flat refuses a projected over-cap result before the native flat call", () =>
    Effect.gen(function* () {
      // One 200k-entry inner array referenced twice projects 400k flattened entries; the
      // count-first guard must refuse before target.flat() materializes them.
      const error = yield* timed(() =>
        failure(`
        const inner = "x".repeat(200_000).split("");
        const outer = [inner, inner];
        return outer.flat().length
      `),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("Array.flat");
      const admitted = yield* run(`return [[1, [2]], [3]].flat(2)`);
      expect(admitted).toMatchObject({ ok: true, value: [1, 2, 3] });
    }),
  );

  it.live("Object.assign and object spread refuse merged over-cap objects as they grow", () =>
    Effect.gen(function* () {
      // Each source is individually inside the cap; the merge of distinct keys is not.
      const seed = `const big = Object.fromEntries("x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split("").entries())`;
      const assign = yield* timed(() =>
        failure(`${seed}; return Object.assign({}, big, { zzz: 1 }).zzz`),
      );
      expect(assign.kind).toBe("InvalidDataValue");
      expect(assign.message).toContain("Object.assign result");
      const spread = yield* timed(() => failure(`${seed}; return ({ ...big, zzz: 1 }).zzz`));
      expect(spread.kind).toBe("InvalidDataValue");
      expect(spread.message).toContain("Object literal");
    }),
  );

  it.live("new Set of an over-cap string is refused before materialization", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`return new Set("x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1})).size`),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("new Set");
    }),
  );

  it.live("URLSearchParams parsing is size-guarded before the native parser runs", () =>
    Effect.gen(function* () {
      const overCap = `"a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 8})`;
      // Direct construction refuses on the projected pair count before the native parser runs.
      const constructed = yield* timed(() =>
        failure(`return new URLSearchParams(${overCap}).size`),
      );
      expect(constructed.kind).toBe("InvalidDataValue");
      // The former smuggle route - an over-cap query hidden inside a URL - is now refused at
      // URL construction itself (the materializing door guards remain as defense in depth).
      const smuggled = yield* timed(() =>
        failure(`return new URL("http://host/?" + ${overCap}).searchParams.size`),
      );
      expect(smuggled.kind).toBe("InvalidDataValue");
      expect(smuggled.message).toContain("new URL");
    }),
  );

  it.live("regex split entries (pieces plus captured separators) are refused over the cap", () =>
    Effect.gen(function* () {
      // A cap-length subject split on a capturing separator projects ~2n+1 entries; the
      // native limit clamps materialization to cap + 1 entries and the result is refused.
      const error = yield* timed(() =>
        failure(`return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split(/(x)/).length`),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("String.split");
      const admitted = yield* run(`return "a1b2c".split(/(\\d)/)`);
      expect(admitted).toMatchObject({ ok: true, value: ["a", "1", "b", "2", "c"] });
      const limited = yield* run(
        `return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split(/(x)/, 4).length`,
      );
      expect(limited).toMatchObject({ ok: true, value: 4 });
    }),
  );

  it.live("String.split with a limit keeps admitting bounded prefixes of long strings", () =>
    Effect.gen(function* () {
      const admitted = yield* run(
        `return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1}).split("", 4).length`,
      );
      expect(admitted).toMatchObject({ ok: true, value: 4 });
    }),
  );
});

describe("URI and URL expansion preflight", () => {
  it.live("encodeURIComponent refuses when the projected expansion exceeds the string cap", () =>
    Effect.gen(function* () {
      // 1.5M ASCII characters project a 4.5M worst case (3x): conservatively refused before
      // the native encoder runs, even though the actual output would have been smaller.
      const ascii = yield* timed(() =>
        failure(`return encodeURIComponent("x".repeat(1_500_000)).length`),
      );
      expect(ascii.kind).toBe("InvalidDataValue");
      // Non-ASCII projects 9x per code unit.
      const wide = yield* timed(() =>
        failure(`return encodeURIComponent("\\u00e9".repeat(600_000)).length`),
      );
      expect(wide.kind).toBe("InvalidDataValue");
      const admitted = yield* run(`return encodeURIComponent("a b/c?")`);
      expect(admitted).toMatchObject({ ok: true, value: "a%20b%2Fc%3F" });
    }),
  );

  it.live("URL construction and property writes are expansion-guarded", () =>
    Effect.gen(function* () {
      const construct = yield* timed(() =>
        failure(`return new URL("http://host/" + "x".repeat(1_500_000)).href.length`),
      );
      expect(construct.kind).toBe("InvalidDataValue");
      const write = yield* timed(() =>
        failure(
          `const u = new URL("http://host/"); u.pathname = "x".repeat(1_500_000); return u.href.length`,
        ),
      );
      expect(write.kind).toBe("InvalidDataValue");
    }),
  );

  it.live("URL query pair count is charged before any native URL/searchParams construction", () =>
    Effect.gen(function* () {
      // ~262K pairs in ~524KB of query text: bounded to build, over the entry cap to parse.
      // Fast refusal is the evidence that no native URL or URLSearchParams materialized it.
      const overCap = `"http://host/?" + "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES})`;
      for (const [code, label] of [
        [`return new URL(${overCap}).href`, "new URL"],
        [`return new URL("p", ${overCap}).href`, "new URL"],
        [`return URL.parse(${overCap})`, "URL.parse"],
        [`return URL.canParse(${overCap})`, "URL.canParse"],
      ] as const) {
        const error = yield* timed(() => failure(code));
        expect(error.kind).toBe("InvalidDataValue");
        expect(error.message).toContain(label);
      }
    }),
  );

  it.live("URL search/href property writes charge the query pair count first", () =>
    Effect.gen(function* () {
      const seed = `const u = new URL("http://host/")`;
      const search = yield* timed(() =>
        failure(`${seed}; u.search = "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES}); return u.href`),
      );
      expect(search.kind).toBe("InvalidDataValue");
      expect(search.message).toContain("URL.search");
      const href = yield* timed(() =>
        failure(
          `${seed}; u.href = "http://host/?" + "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES}); return u.href`,
        ),
      );
      expect(href.kind).toBe("InvalidDataValue");
      expect(href.message).toContain("URL.href");
    }),
  );

  it.live("URL query admission is exact at the cap, and fragment ampersands are ignored", () =>
    Effect.gen(function* () {
      // Exactly the cap: (cap - 1) separators + 1 = cap projected pairs - admitted.
      const exact = yield* timed(
        () =>
          run(
            `return new URL("http://host/?" + "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES - 1}) + "a").search.length`,
          ),
        ADMITTED_AT_CAP_MS,
      );
      expect(exact).toMatchObject({ ok: true });
      // Ampersands after the fragment start are not query pairs and must not be charged.
      const fragment = yield* timed(
        () =>
          run(
            `return new URL("http://host/?a=1#" + "&".repeat(${MAX_GUEST_COLLECTION_ENTRIES})).searchParams.size`,
          ),
        ADMITTED_AT_CAP_MS,
      );
      expect(fragment).toMatchObject({ ok: true, value: 1 });
    }),
  );

  it.live("URLSearchParams.toString charges its projected serialization first", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`
        const p = new URLSearchParams();
        p.append("k", "y".repeat(2_000_000));
        return p.toString().length
      `),
      );
      expect(error.kind).toBe("InvalidDataValue");
      const admitted = yield* run(
        `const p = new URLSearchParams(); p.append("a", "1 2"); return p.toString()`,
      );
      expect(admitted).toMatchObject({ ok: true, value: "a=1+2" });
    }),
  );
});

describe("JSON and log growth limits", () => {
  it.live("JSON.stringify output over the string cap is refused by preflight estimate", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(`const s = "x".repeat(4_000_000); return JSON.stringify([s, s]).length`),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("JSON.stringify");
    }),
  );

  it.live("JSON.stringify charges actual indentation before allocating output", () =>
    Effect.gen(function* () {
      const error = yield* timed(() =>
        failure(
          `const s = "x".repeat(${MAX_GUEST_STRING_LENGTH} - 4); return JSON.stringify([s], null, 2).length`,
        ),
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(
        yield* run(
          `const s = "x".repeat(${MAX_GUEST_STRING_LENGTH} - 4); return JSON.stringify([s]).length`,
        ),
      ).toMatchObject({ ok: true, value: MAX_GUEST_STRING_LENGTH });
      const fits = yield* run(`return JSON.stringify({ a: 1 }, null, 2)`);
      expect(fits).toMatchObject({ ok: true, value: '{\n  "a": 1\n}' });
    }),
  );

  it.live("console output is bounded during the run: entry size and entry count", () =>
    Effect.gen(function* () {
      const result = yield* run(`
      console.log("x".repeat(50_000));
      for (let i = 0; i < ${MAX_LOG_ENTRIES + 20}; i += 1) console.log("line " + i);
      return "done";
    `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.logs).toHaveLength(MAX_LOG_ENTRIES + 1);
      expect(result.logs?.[0]).toMatch(
        new RegExp(`^x+… \\[log entry truncated to ${MAX_LOG_ENTRY_LENGTH} characters\\]$`),
      );
      expect(result.logs?.at(-1)).toBe(
        `[logs truncated: further console output beyond ${MAX_LOG_ENTRIES} entries was dropped]`,
      );
    }),
  );

  it.live("console rendering of huge structures stays bounded per entry", () =>
    Effect.gen(function* () {
      const result = yield* timed(() =>
        run(`
        const s = "y".repeat(1_000_000);
        const arr = [];
        for (let i = 0; i < 100; i += 1) arr.push(s);
        console.log(arr);
        return "ok";
      `),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.logs?.[0]?.length).toBeLessThanOrEqual(MAX_LOG_ENTRY_LENGTH + 64);
    }),
  );
});

describe("aggregate data-boundary budgets", () => {
  it("refuses shared DAG expansion at both copy doors without materializing the tree", () => {
    let value: InterpreterValue = [0];
    for (let i = 0; i < 18; i++) value = [value, value];
    expect(() => copyIn(value, "DAG")).toThrow(/expanded data budget/);
    expect(() => copyOut(value)).toThrow(/expanded data budget/);
    const text = "x".repeat(MAX_GUEST_STRING_LENGTH);
    expect(() => copyIn([text, text, text], "Text DAG")).toThrow(/expanded data budget/);
    expect(() => copyOut([text, text, text])).toThrow(/expanded data budget/);
  });

  it("charges sparse container slots before descending into more allocations", () => {
    let value: InterpreterValue = null;
    for (let i = 0; i < 4; i++) {
      const sparse: Array<InterpreterValue> = [];
      sparse.length = MAX_GUEST_COLLECTION_ENTRIES;
      sparse[0] = value;
      value = sparse;
    }
    expect(() => copyIn(value, "Sparse amplification")).toThrow(/expanded data budget/);
    expect(() => copyOut(value)).toThrow(/expanded data budget/);
  });

  it("keeps full-size flat values, pair collections, sparse arrays and boundary scalars", () => {
    const array = Array.from({ length: MAX_GUEST_COLLECTION_ENTRIES }, () => 1);
    expect(copyOut(copyIn(array, "Exact fit"))).toEqual(array);
    const pairs = array.map((value, index) => [index, value]);
    expect(copyOut(copyIn(pairs, "Exact pairs"))).toEqual(pairs);
    const sparse: Array<InterpreterValue> = [];
    sparse.length = MAX_GUEST_COLLECTION_ENTRIES;
    sparse[1] = undefined;
    const result = copyOut(copyIn(sparse, "Sparse"));
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error("expected array");
    expect(result).toHaveLength(MAX_GUEST_COLLECTION_ENTRIES);
    // Holes leave the sandbox as JSON nulls.
    expect(0 in result).toBe(true);
    expect(result[0]).toBe(null);
    expect(result[1]).toBe(null);
    expect(
      copyOut(copyIn([NaN, Infinity, hostDate(0), new URL("https://example.com")], "Scalars")),
    ).toEqual([null, null, "1970-01-01T00:00:00.000Z", "https://example.com/"]);
    const text = "\u0000".repeat(MAX_GUEST_STRING_LENGTH);
    expect(copyOut(copyIn(text, "Exact string"))).toBe(text);
  });

  it("evaluates shared getters per occurrence, including accessor-dependent ancestors", () => {
    for (const copy of [copyIn, (value: InterpreterValue) => copyOut(value)]) {
      let reads = 0;
      const shared = {
        get value() {
          return ++reads;
        },
      };
      const ancestor = { child: [shared] };
      const result = copy([shared, shared, ancestor, ancestor], "Host data");
      expect(reads).toBe(4);
      expect(result).toEqual([
        { value: 1 },
        { value: 2 },
        { child: [{ value: 3 }] },
        { child: [{ value: 4 }] },
      ]);
      if (!Array.isArray(result)) throw new Error("expected array");
      expect(result[0]).not.toBe(result[1]);
      expect(result[2]).not.toBe(result[3]);
    }
    expect(() => copyIn({ toJSON: () => 1 }, "Callback")).toThrow(/data only/);
  });

  it("preserves sparse getter indices and invalidates data memoized before getter mutations", () => {
    let reads = 0;
    const sparse: Array<InterpreterValue> = [];
    sparse.length = 3;
    Object.defineProperty(sparse, 1, { get: () => ++reads, enumerable: true });
    const copied = copyIn([sparse, sparse], "Sparse getters");
    if (!Array.isArray(copied)) throw new Error("expected array");
    for (const [index, item] of copied.entries()) {
      if (!Array.isArray(item)) throw new Error("expected nested array");
      expect(item).toHaveLength(3);
      expect(0 in item).toBe(false);
      expect(item[1]).toBe(index + 1);
      expect(2 in item).toBe(false);
    }
    expect(reads).toBe(2);
    const plain = { value: 1 };
    const accessor = {
      get change() {
        plain.value++;
        return 0;
      },
    };
    expect(copyIn([plain, accessor, plain], "Mutation")).toEqual([
      { value: 1 },
      { change: 0 },
      { value: 2 },
    ]);
  });

  it("checks shared DAG reachability once per identity without hiding later references", () => {
    let visits = 0;
    const leaf = {
      get value() {
        // Fail promptly if visited-identity tracking regresses, rather than traversing 2^31 leaves.
        if (++visits > 64) throw new Error("Shared graph traversal exceeded its work budget");
        return 0;
      },
    };
    let dag: InterpreterValue = [leaf];
    for (let i = 0; i < 31; i++) dag = [dag, dag];
    for (const contains of [containsRuntimeReference, containsOpaqueReference]) {
      expect(contains(dag)).toBe(false);
      expect(contains([dag, { hidden: Symbol("opaque") }])).toBe(true);
    }
  });

  // A DAG with 2^31 paths: a walk that revisits shared members would never finish, so the
  // test's own timeout is the regression guard.
  it.effect("bounds shared DAG insertion walks for assignment and push without hiding cycles", () =>
    Effect.gen(function* () {
      for (const [container, insert] of [
        ["{}", "y.x = x"],
        ["[]", "y.push(x)"],
      ]) {
        for (const cyclic of [false, true]) {
          const result = yield* run(`
            const y = ${container};
            let x = {};
            for (let i = 0; i < 31; i++) x = { a: x, b: x };
            ${cyclic ? "x = { shared: x, later: y };" : ""}
            ${insert};
            return 1;
          `);
          if (cyclic) {
            expect(result).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } });
          } else {
            expect(result).toMatchObject({ ok: true, value: 1 });
          }
        }
        expect(yield* run(`const y = ${container}; const x = y; ${insert};`)).toMatchObject({
          ok: false,
          error: { kind: "InvalidDataValue" },
        });
      }
    }),
  );

  it.effect("preserves occurrence-based getters in host tool results", () =>
    Effect.gen(function* () {
      let reads = 0;
      const shared = {
        get value() {
          return ++reads;
        },
      };
      const ancestor = { child: shared };
      const result = yield* CodeMode.execute({
        code: "const result = await tools.load({}); result[0].child.value = 99; return result;",
        tools: {
          load: Tool.make({
            description: "Load getter data",
            input: Schema.Unknown,
            output: Schema.Unknown,
            run: () => Effect.succeed([ancestor, ancestor]),
          }),
        },
      });
      expect(result).toMatchObject({
        ok: true,
        value: [{ child: { value: 99 } }, { child: { value: 2 } }],
      });
      expect(reads).toBe(2);
    }),
  );

  it.effect("refuses amplified final returns and tool inputs before dispatch", () =>
    Effect.gen(function* () {
      const seed = "let a = [0]; for (let i = 0; i < 18; i++) a = [a, a];";
      let dispatched = false;
      for (const code of [
        `${seed} return a;`,
        `${seed} return await tools.take(a);`,
        `const a = "x".repeat(${MAX_GUEST_STRING_LENGTH}); return await tools.take(a, a, a);`,
      ]) {
        const result = yield* CodeMode.execute({
          code,
          tools: {
            take: Tool.make({
              description: "Accept data",
              input: Schema.Unknown,
              output: Schema.Boolean,
              run: () =>
                Effect.sync(() => {
                  dispatched = true;
                  return true;
                }),
            }),
          },
          limits: { maxOutputBytes: 1000 },
        });
        expect(result).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } });
      }
      expect(dispatched).toBe(false);
    }),
  );

  it.effect("refuses amplified host output and admits a full-size primitive tool argument", () =>
    Effect.gen(function* () {
      let value: InterpreterValue = [0];
      for (let i = 0; i < 18; i++) value = [value, value];
      const rejected = yield* CodeMode.execute({
        code: "return await tools.load({});",
        tools: {
          load: Tool.make({
            description: "Return shared data",
            input: Schema.Unknown,
            output: Schema.Unknown,
            run: () => Effect.succeed(value),
          }),
        },
      });
      expect(rejected).toMatchObject({ ok: false, error: { kind: "InvalidToolOutput" } });
      const array = Array.from({ length: MAX_GUEST_COLLECTION_ENTRIES }, () => 1);
      const admitted = yield* CodeMode.execute({
        code: "const a = await tools.load({}); return await tools.take(a);",
        tools: {
          load: Tool.make({
            description: "Return full array",
            input: Schema.Unknown,
            output: Schema.Unknown,
            run: () => Effect.succeed(array),
          }),
          take: Tool.make({
            description: "Count input",
            input: Schema.Unknown,
            output: Schema.Finite,
            run: (input) => Effect.succeed(Array.isArray(input) ? input.length : -1),
          }),
        },
      });
      expect(admitted).toMatchObject({ ok: true, value: MAX_GUEST_COLLECTION_ENTRIES });
    }),
  );
});

describe("wall-clock timeout normalization", () => {
  it.live("a busy loop is normalized to TimeoutExceeded by the interpreter deadline", () =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* run(`let x = 0; while (true) { x += 1; } return x`, {
        timeoutMs: 100,
      });
      const endedAt = yield* Clock.currentTimeMillis;
      expect(endedAt - startedAt).toBeLessThan(3_000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("TimeoutExceeded");
        expect(result.error.message).toContain("timed out after 100ms");
      }
    }),
  );

  it.live("deadline expiry inside synchronous native work is normalized, never ok:true", () =>
    Effect.gen(function* () {
      // Deterministic clock: every deadline observation advances the wall clock by half the
      // 1ms budget, simulating admitted synchronous native work (each repeat is individually
      // admitted) that overruns the deadline while the event loop is blocked and the Effect
      // timer cannot fire. The interpreter must normalize the overrun to TimeoutExceeded at
      // the next step - never return ok:true - regardless of how fast the machine is.
      let nowMs = 0;
      setDeadlineClockForTesting(() => (nowMs += 0.5));
      try {
        const result = yield* run(
          `
        let out = 0;
        for (let i = 0; i < 50; i += 1) out += "x".repeat(3_000_000).length;
        return out;
      `,
          { timeoutMs: 1 },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.kind).toBe("TimeoutExceeded");
          expect(result.error.message).toContain("timed out after 1ms");
        }
      } finally {
        setDeadlineClockForTesting(undefined);
      }
    }),
  );
});
