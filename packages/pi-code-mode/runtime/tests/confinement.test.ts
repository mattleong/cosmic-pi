// Local confinement suite (not vendored from upstream; see PROVENANCE.md): hostile regex
// refusal, amplification limits, collection growth, JSON/log growth, and wall-clock timeout
// normalization. Every hostile case asserts *fast* refusal - the point of the confinement
// layer is that no admitted native operation can block the event loop for seconds.
import { describe, expect, test } from "vitest";
import { Effect, Schema } from "effect";
import { CodeMode, Tool } from "../src/index.js";
import {
  MAX_GUEST_COLLECTION_ENTRIES,
  MAX_GUEST_STRING_LENGTH,
  MAX_LOG_ENTRIES,
  MAX_LOG_ENTRY_LENGTH,
  regexSubjectCap,
  setDeadlineClockForTesting,
} from "../src/interpreter/confinement.js";

const run = (code: string, limits?: CodeMode.ExecutionLimits) =>
  Effect.runPromise(CodeMode.execute(limits ? { code, limits } : { code }));

const failure = async (code: string, limits?: CodeMode.ExecutionLimits) => {
  const result = await run(code, limits);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  return result.error;
};

/** Asserts the program settles fast - hostile inputs must be refused, not endured. */
const timed = async <A>(work: () => Promise<A>, maxMs = 1_500): Promise<A> => {
  const startedAt = Date.now();
  const value = await work();
  expect(Date.now() - startedAt).toBeLessThan(maxMs);
  return value;
};

describe("regex confinement: hostile patterns are refused fast", () => {
  test("the audit repro /(a+)+$/ is rejected at construction, not executed for seconds", async () => {
    const error = await timed(() =>
      failure(`return /(a+)+$/.test("${"a".repeat(28)}!")`, { timeoutMs: 10_000 }),
    );
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("group that itself contains a quantifier");
  });

  test("nested quantifiers are rejected through every construction door", async () => {
    for (const code of [
      `return /(a+)+$/.test("aaa")`,
      `return new RegExp("(a+)+$").test("aaa")`,
      `return "aaa".match("(a+)+$")`,
      `return "aaa".split(/(a*)*b/)`,
      `return "aaa".replaceAll(/(a+)*b/g, "x")`,
    ]) {
      const error = await timed(() => failure(code));
      expect(error.kind).toBe("UnsupportedSyntax");
    }
  });

  test("alternation inside a repeated group is rejected (exponential family)", async () => {
    const error = await timed(() => failure(`return /(a|aa)+$/.test("${"a".repeat(24)}!")`));
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("alternation");
    expect(error.message).toContain("character class");
  });

  test("backreferences and named backreferences are rejected", async () => {
    for (const code of [`return /(a)\\1/.test("aa")`, `return /(?<x>a)\\k<x>/.test("aa")`]) {
      const error = await timed(() => failure(code));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("backreference");
    }
  });

  test("quantified lookarounds, oversized bounds, and too many optionals are rejected", async () => {
    expect((await failure(`return /(?=a)+b/.test("ab")`)).kind).toBe("UnsupportedSyntax");
    expect((await failure(`return /a{1,500}/.test("a")`)).kind).toBe("UnsupportedSyntax");
    expect((await failure(`return /a?b?c?d?e?f?g?h?i?/.test("x")`)).kind).toBe("UnsupportedSyntax");
    expect((await failure(`return new RegExp("a".repeat(1200)).test("a")`)).kind).toBe(
      "UnsupportedSyntax",
    );
  });

  test("the polynomial-backtracking audit repro /a*a*a*a*a*a*b/ is rejected, not executed", async () => {
    // Six independent unbounded quantifiers backtrack polynomially: on a 44-character
    // subject this pattern stalls native matching for ~half a second, far past a small
    // timeoutMs, and no cooperative deadline can interrupt it. The conservative screen
    // must refuse the pattern itself, deterministically, before any native match runs.
    const error = await timed(
      () => failure(`return /a*a*a*a*a*a*b/.test("a".repeat(44))`, { timeoutMs: 10 }),
      1_000,
    );
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("unbounded quantifiers");
  });

  test("the polynomial family is rejected through every construction door", async () => {
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
      const error = await timed(() => failure(code));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("unbounded quantifiers");
    }
  });

  test("subjects over the pattern's backtracking budget are refused with guidance", async () => {
    // One unbounded quantifier, unanchored: degree 2 -> 2048-character cap.
    const error = await timed(() =>
      failure(`return /x+y/.test("x".repeat(20000) + "z")`, { timeoutMs: 10_000 }),
    );
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("backtracking budget");
    expect(error.message).toContain("split('\\n')");
  });

  test("three admitted unbounded quantifiers get only the smallest subject cap", async () => {
    // /a*a*a*b/ passes the count screen (3 unbounded) but is degree 4 unanchored: only
    // subjects up to the 64-character cap are admitted, so its polynomial worst case stays
    // bounded to well under the strictest deadline granularity.
    const error = await timed(() => failure(`return /a*a*a*b/.test("a".repeat(65))`));
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("backtracking budget");
    const admitted = await timed(() => run(`return /a*a*a*b/.test("a".repeat(44))`));
    expect(admitted).toMatchObject({ ok: true, value: false });
  });

  test("optional quantifiers divide the admitted subject cap by their branch factor", async () => {
    // Eight optionals multiply a 256x branch factor into every match attempt: degree 1
    // anchored keeps the 262144 base cap, divided down to 1024 admitted characters.
    const pattern = `/^a?a?a?a?a?a?a?a?b/`;
    const error = await timed(() => failure(`return ${pattern}.test("a".repeat(2000))`));
    expect(error.kind).toBe("InvalidDataValue");
    const admitted = await timed(() => run(`return ${pattern}.test("a".repeat(500))`));
    expect(admitted).toMatchObject({ ok: true, value: false });
  });

  test("variable counted repetitions are charged as branch factor and rejected past it", async () => {
    // {0,200} contributes a 201-way branch; two of them multiply past the 256 factor cap.
    const error = await timed(() => failure(`return /a{0,200}a{0,200}b/.test("aaa")`));
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("branch factor");
  });

  test("anchored single-quantifier patterns keep working on large subjects", async () => {
    const result = await timed(() => run(`return /^a+$/.test("a".repeat(100000))`));
    expect(result).toMatchObject({ ok: true, value: true });
  });

  test("everyday regex usage is preserved", async () => {
    const result = await timed(() =>
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
  });

  test("the ambiguous-alternation audit repro is rejected statically, never matched", async () => {
    // Twelve anchored (a|aa) groups multiply a 2^12 choice factor into every attempt:
    // admitted, this takes ~400ms of native backtracking at timeoutMs=10. The screen must
    // reject the pattern itself - deterministically, before any native match runs - because
    // both branches can start on the same character.
    const groups = "(a|aa)".repeat(12);
    const error = await timed(
      () => failure(`return /^${groups}b$/.test("${"a".repeat(24)}")`, { timeoutMs: 10 }),
      1_000,
    );
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("alternation branches can start with the same character");
  });

  test("ambiguous alternation is rejected through every construction and match door", async () => {
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
      const error = await timed(() => failure(code));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("alternation");
    }
  });

  test("alternation ambiguity screen: nested, empty, escaped, and class variants", async () => {
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
      const error = await timed(() => failure(`return ${pattern}.test("abc")`));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("alternation");
    }
    // Adjacent disjoint alternatives stay admitted for everyday use.
    const admitted = await timed(() =>
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
  });

  test("inline flag-modifier groups are rejected through every construction and match door", async () => {
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
      const error = await timed(() => failure(code, { timeoutMs: 10_000 }));
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("inline flag-modifier group");
    }
  });

  test("the repeated modifier-group ambiguous-alternation family is rejected statically", async () => {
    // Twelve (?i:a|aa) groups are the (a|aa)(a|aa)...b audit family behind a modifier
    // prefix: admitted, this backtracks for hundreds of milliseconds at timeoutMs=10.
    const groups = "(?i:a|aa)".repeat(12);
    const error = await timed(
      () => failure(`return /^${groups}b$/.test("${"a".repeat(24)}")`, { timeoutMs: 10 }),
      1_000,
    );
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("inline flag-modifier group");
  });

  test("every valid modifier-prefix shape is rejected; malformed ones keep syntax diagnostics", async () => {
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
      const error = await timed(() =>
        failure(`return new RegExp(${JSON.stringify(pattern)}).test("a")`),
      );
      expect(error.kind).toBe("UnsupportedSyntax");
      expect(error.message).toContain("inline flag-modifier group");
    }
    // Malformed modifier-like groups never reach the screen: the native constructor rejects
    // them first and the normal guest-catchable SyntaxError diagnostic is preserved.
    const malformed = await timed(() =>
      run(`
        return ["(?ii:a)", "(?i-i:a)", "(?-:a)", "(?i)a", "(?x:a)"].map((pattern) => {
          try { new RegExp(pattern); return "constructed"; }
          catch (e) { return e instanceof SyntaxError && !e.message.includes("inline flag-modifier"); }
        });
      `),
    );
    expect(malformed).toMatchObject({ ok: true, value: [true, true, true, true, true] });
    // Noncapturing groups, lookarounds, and named groups stay admitted unchanged.
    const admitted = await timed(() =>
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
  });

  test("admitted disjoint alternations charge the combined branch factor", async () => {
    // Nine 2-branch alternations multiply a 512-way branch factor: over the 256 cap.
    const over = "(a|b)(c|d)(e|f)(g|h)(i|j)(k|l)(m|n)(o|p)(q|r)";
    const error = await timed(() => failure(`return /${over}/.test("aceg")`));
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("branch factor");
    // Eight stay admitted (factor 256), with the subject cap divided accordingly.
    const eight = "(a|b)(c|d)(e|f)(g|h)(i|j)(k|l)(m|n)(o|p)";
    const admitted = await timed(() => run(`return /${eight}/.test("acegikmo")`));
    expect(admitted).toMatchObject({ ok: true, value: true });
    const capped = await timed(() => failure(`return /${eight}/.test("z".repeat(2000))`));
    expect(capped.kind).toBe("InvalidDataValue");
    expect(capped.message).toContain("backtracking budget");
  });

  test("a [^] class cannot hide quantifiers from the scanner (engine ] semantics)", async () => {
    // The engine closes [^] immediately, so the six quantifiers here are real pattern atoms
    // (the trailing ] is a literal); a class scan that treated the first ] as a literal
    // member would skip them all and admit the polynomial family at full subject caps.
    const error = await timed(() =>
      failure(`return /[^]a*a*a*a*a*a*b]/.test("${"a".repeat(44)}")`),
    );
    expect(error.kind).toBe("UnsupportedSyntax");
    expect(error.message).toContain("unbounded quantifiers");
  });

  test("subject caps scale down with the pattern's residual degree and branch factor", () => {
    expect(regexSubjectCap(1)).toBe(262_144);
    expect(regexSubjectCap(2)).toBe(2_048);
    expect(regexSubjectCap(3)).toBe(128);
    expect(regexSubjectCap(4)).toBe(64);
    expect(regexSubjectCap(9)).toBe(64);
    expect(regexSubjectCap(1, 256)).toBe(1_024);
    expect(regexSubjectCap(2, 256)).toBe(16);
    expect(regexSubjectCap(4, 256)).toBe(16);
  });

  test("lookarounds are charged as unbounded work", async () => {
    // Four lookarounds exceed the unbounded budget outright.
    const rejected = await timed(() => failure(`return /(?=a)(?=b)(?=c)(?=d)x/.test("x")`));
    expect(rejected.kind).toBe("UnsupportedSyntax");
    // A single lookaround stays admitted for everyday validation patterns.
    const admitted = await timed(() => run(`return /^(?=.*x)[a-z]+$/.test("axb")`));
    expect(admitted).toMatchObject({ ok: true, value: true });
  });
});

describe("string amplification limits", () => {
  test("String.repeat over the cap is refused before allocation", async () => {
    const error = await timed(() => failure(`return "a".repeat(10_000_000)`));
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("String.repeat");
  });

  test("doubling concatenation is refused at the fixed cap, fast", async () => {
    const error = await timed(() =>
      failure(`let s = "a"; while (true) { s = s + s; } return s.length`, {
        timeoutMs: 30_000,
      }),
    );
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("String concatenation");
  });

  test("template literals, padStart, and concat are charged up front", async () => {
    const big = `const s = "x".repeat(${MAX_GUEST_STRING_LENGTH - 8})`;
    expect((await failure(`${big}; return \`--\${s}\${s}--\``)).kind).toBe("InvalidDataValue");
    expect((await failure(`return "x".padStart(100_000_000)`)).kind).toBe("InvalidDataValue");
    expect((await failure(`${big}; return s.concat(s)`)).kind).toBe("InvalidDataValue");
  });

  test("String(...) coercion of huge nested arrays is budgeted", async () => {
    const error = await timed(() =>
      failure(`const s = "x".repeat(2_000_000); return String([s, s, s]).length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
  });

  test("global replace expansion is charged before the native call", async () => {
    const error = await timed(() =>
      failure(`return "${"a".repeat(64)}".replaceAll("a", "b".repeat(1_000_000)).length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
  });

  test("a tool result over the string cap is refused at the data boundary", async () => {
    const oversized = Tool.make({
      description: "Return an oversized payload",
      input: Schema.Struct({}),
      output: Schema.String,
      run: () => Effect.succeed("x".repeat(MAX_GUEST_STRING_LENGTH + 1)),
    });
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { oversized } },
        code: `return await tools.host.oversized({})`,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("InvalidToolOutput");
  });
});

describe("collection growth limits", () => {
  test("split results over the entry cap are refused", async () => {
    const error = await timed(() =>
      failure(`return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1}).split("").length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
  });

  test("sparse array index assignment cannot fabricate huge arrays", async () => {
    const error = await timed(() =>
      failure(`const a = [1]; a[1_000_000_000] = 2; return a.length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("Array assignment");
  });

  test("push, concat, splice, and flatMap growth is charged before mutation", async () => {
    const seed = `const a = "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split("")`;
    expect((await failure(`${seed}; a.push(1); return a.length`)).kind).toBe("InvalidDataValue");
    expect((await failure(`${seed}; return a.concat(a).length`)).kind).toBe("InvalidDataValue");
    expect((await failure(`${seed}; a.splice(0, 0, 1); return a.length`)).kind).toBe(
      "InvalidDataValue",
    );
    expect((await failure(`${seed}; return a.flatMap((x) => [x, x]).length`)).kind).toBe(
      "InvalidDataValue",
    );
  });

  test("array spread over the entry cap is refused", async () => {
    const error = await timed(() =>
      failure(
        `const a = "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split(""); return [0, ...a].length`,
      ),
    );
    expect(error.kind).toBe("InvalidDataValue");
  });

  test("Array.from refuses a forged array-like length before any native allocation", async () => {
    // The guard must fire on the projected length alone: a billion-entry (or Infinity)
    // allocation would exhaust process memory if the native call ran first, so fast refusal
    // here is itself the evidence that nothing was allocated.
    for (const length of ["1_000_000_000", "Infinity", `${MAX_GUEST_COLLECTION_ENTRIES + 1}`]) {
      const error = await timed(
        () => failure(`return Array.from({ length: ${length} }).length`),
        1_000,
      );
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain("Array.from");
    }
    // ToLength semantics for admitted array-likes are preserved.
    const admitted = await run(
      `return [Array.from({ length: 2, 0: "a", 1: "b" }), Array.from({ length: -5 }), Array.from({ length: 2.9 }).length]`,
    );
    expect(admitted).toMatchObject({ ok: true, value: [["a", "b"], [], 2] });
  });

  test("Array.from of a string over the entry cap is refused before materialization", async () => {
    const error = await timed(() =>
      failure(`return Array.from("x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1})).length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
    // for...of iterates the same string lazily and stays admitted.
    const iterated = await timed(() =>
      run(`for (const c of "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1})) { return c; }`),
    );
    expect(iterated).toMatchObject({ ok: true, value: "x" });
  });

  test("Array.flat refuses a projected over-cap result before the native flat call", async () => {
    // One 200k-entry inner array referenced twice projects 400k flattened entries; the
    // count-first guard must refuse before target.flat() materializes them.
    const error = await timed(() =>
      failure(`
        const inner = "x".repeat(200_000).split("");
        const outer = [inner, inner];
        return outer.flat().length
      `),
    );
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("Array.flat");
    const admitted = await run(`return [[1, [2]], [3]].flat(2)`);
    expect(admitted).toMatchObject({ ok: true, value: [1, 2, 3] });
  });

  test("Object.assign and object spread refuse merged over-cap objects as they grow", async () => {
    // Each source is individually inside the cap; the merge of distinct keys is not.
    const seed = `const big = Object.fromEntries("x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split("").entries())`;
    const assign = await timed(() =>
      failure(`${seed}; return Object.assign({}, big, { zzz: 1 }).zzz`),
    );
    expect(assign.kind).toBe("InvalidDataValue");
    expect(assign.message).toContain("Object.assign result");
    const spread = await timed(() => failure(`${seed}; return ({ ...big, zzz: 1 }).zzz`));
    expect(spread.kind).toBe("InvalidDataValue");
    expect(spread.message).toContain("Object literal");
  });

  test("new Set of an over-cap string is refused before materialization", async () => {
    const error = await timed(() =>
      failure(`return new Set("x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1})).size`),
    );
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("new Set");
  });

  test("URLSearchParams parsing is size-guarded before the native parser runs", async () => {
    const overCap = `"a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 8})`;
    // Direct construction refuses on the projected pair count before the native parser runs.
    const constructed = await timed(() => failure(`return new URLSearchParams(${overCap}).size`));
    expect(constructed.kind).toBe("InvalidDataValue");
    // The former smuggle route - an over-cap query hidden inside a URL - is now refused at
    // URL construction itself (the materializing door guards remain as defense in depth).
    const smuggled = await timed(() =>
      failure(`return new URL("http://host/?" + ${overCap}).searchParams.size`),
    );
    expect(smuggled.kind).toBe("InvalidDataValue");
    expect(smuggled.message).toContain("new URL");
  });

  test("regex split entries (pieces plus captured separators) are refused over the cap", async () => {
    // A cap-length subject split on a capturing separator projects ~2n+1 entries; the
    // native limit clamps materialization to cap + 1 entries and the result is refused.
    const error = await timed(() =>
      failure(`return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split(/(x)/).length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("String.split");
    const admitted = await run(`return "a1b2c".split(/(\\d)/)`);
    expect(admitted).toMatchObject({ ok: true, value: ["a", "1", "b", "2", "c"] });
    const limited = await run(
      `return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES}).split(/(x)/, 4).length`,
    );
    expect(limited).toMatchObject({ ok: true, value: 4 });
  });

  test("String.split with a limit keeps admitting bounded prefixes of long strings", async () => {
    const admitted = await run(
      `return "x".repeat(${MAX_GUEST_COLLECTION_ENTRIES + 1}).split("", 4).length`,
    );
    expect(admitted).toMatchObject({ ok: true, value: 4 });
  });
});

describe("URI and URL expansion preflight", () => {
  test("encodeURIComponent refuses when the projected expansion exceeds the string cap", async () => {
    // 1.5M ASCII characters project a 4.5M worst case (3x): conservatively refused before
    // the native encoder runs, even though the actual output would have been smaller.
    const ascii = await timed(() =>
      failure(`return encodeURIComponent("x".repeat(1_500_000)).length`),
    );
    expect(ascii.kind).toBe("InvalidDataValue");
    // Non-ASCII projects 9x per code unit.
    const wide = await timed(() =>
      failure(`return encodeURIComponent("\\u00e9".repeat(600_000)).length`),
    );
    expect(wide.kind).toBe("InvalidDataValue");
    const admitted = await run(`return encodeURIComponent("a b/c?")`);
    expect(admitted).toMatchObject({ ok: true, value: "a%20b%2Fc%3F" });
  });

  test("URL construction and property writes are expansion-guarded", async () => {
    const construct = await timed(() =>
      failure(`return new URL("http://host/" + "x".repeat(1_500_000)).href.length`),
    );
    expect(construct.kind).toBe("InvalidDataValue");
    const write = await timed(() =>
      failure(
        `const u = new URL("http://host/"); u.pathname = "x".repeat(1_500_000); return u.href.length`,
      ),
    );
    expect(write.kind).toBe("InvalidDataValue");
  });

  test("URL query pair count is charged before any native URL/searchParams construction", async () => {
    // ~262K pairs in ~524KB of query text: bounded to build, over the entry cap to parse.
    // Fast refusal is the evidence that no native URL or URLSearchParams materialized it.
    const overCap = `"http://host/?" + "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES})`;
    for (const [code, label] of [
      [`return new URL(${overCap}).href`, "new URL"],
      [`return new URL("p", ${overCap}).href`, "new URL"],
      [`return URL.parse(${overCap})`, "URL.parse"],
      [`return URL.canParse(${overCap})`, "URL.canParse"],
    ] as const) {
      const error = await timed(() => failure(code));
      expect(error.kind).toBe("InvalidDataValue");
      expect(error.message).toContain(label);
    }
  });

  test("URL search/href property writes charge the query pair count first", async () => {
    const seed = `const u = new URL("http://host/")`;
    const search = await timed(() =>
      failure(`${seed}; u.search = "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES}); return u.href`),
    );
    expect(search.kind).toBe("InvalidDataValue");
    expect(search.message).toContain("URL.search");
    const href = await timed(() =>
      failure(
        `${seed}; u.href = "http://host/?" + "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES}); return u.href`,
      ),
    );
    expect(href.kind).toBe("InvalidDataValue");
    expect(href.message).toContain("URL.href");
  });

  test("URL query admission is exact at the cap, and fragment ampersands are ignored", async () => {
    // Exactly the cap: (cap - 1) separators + 1 = cap projected pairs - admitted.
    const exact = await timed(() =>
      run(
        `return new URL("http://host/?" + "a&".repeat(${MAX_GUEST_COLLECTION_ENTRIES - 1}) + "a").search.length`,
      ),
    );
    expect(exact).toMatchObject({ ok: true });
    // Ampersands after the fragment start are not query pairs and must not be charged.
    const fragment = await timed(() =>
      run(
        `return new URL("http://host/?a=1#" + "&".repeat(${MAX_GUEST_COLLECTION_ENTRIES})).searchParams.size`,
      ),
    );
    expect(fragment).toMatchObject({ ok: true, value: 1 });
  });

  test("URLSearchParams.toString charges its projected serialization first", async () => {
    const error = await timed(() =>
      failure(`
        const p = new URLSearchParams();
        p.append("k", "y".repeat(2_000_000));
        return p.toString().length
      `),
    );
    expect(error.kind).toBe("InvalidDataValue");
    const admitted = await run(
      `const p = new URLSearchParams(); p.append("a", "1 2"); return p.toString()`,
    );
    expect(admitted).toMatchObject({ ok: true, value: "a=1+2" });
  });
});

describe("JSON and log growth limits", () => {
  test("JSON.stringify output over the string cap is refused by preflight estimate", async () => {
    const error = await timed(() =>
      failure(`const s = "x".repeat(4_000_000); return JSON.stringify([s, s]).length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
    expect(error.message).toContain("JSON.stringify");
  });

  test("indented JSON.stringify runs against a proportionally smaller budget", async () => {
    const error = await timed(() =>
      failure(`const s = "x".repeat(1_000_000); return JSON.stringify([s], null, 2).length`),
    );
    expect(error.kind).toBe("InvalidDataValue");
    const fits = await run(`return JSON.stringify({ a: 1 }, null, 2)`);
    expect(fits).toMatchObject({ ok: true, value: '{\n  "a": 1\n}' });
  });

  test("console output is bounded during the run: entry size and entry count", async () => {
    const result = await run(`
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
  });

  test("console rendering of huge structures stays bounded per entry", async () => {
    const result = await timed(() =>
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
  });
});

describe("wall-clock timeout normalization", () => {
  test("a busy loop is normalized to TimeoutExceeded by the interpreter deadline", async () => {
    const startedAt = Date.now();
    const result = await run(`let x = 0; while (true) { x += 1; } return x`, {
      timeoutMs: 100,
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("TimeoutExceeded");
      expect(result.error.message).toContain("timed out after 100ms");
    }
  });

  test("deadline expiry inside synchronous native work is normalized, never ok:true", async () => {
    // Deterministic clock: every deadline observation advances the wall clock by half the
    // 1ms budget, simulating admitted synchronous native work (each repeat is individually
    // admitted) that overruns the deadline while the event loop is blocked and the Effect
    // timer cannot fire. The interpreter must normalize the overrun to TimeoutExceeded at
    // the next step - never return ok:true - regardless of how fast the machine is.
    let nowMs = 0;
    setDeadlineClockForTesting(() => (nowMs += 0.5));
    try {
      const result = await run(
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
  });
});
