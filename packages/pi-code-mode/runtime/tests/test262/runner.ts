import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { CodeMode } from "../../src/index.js";

const Manifest = Schema.Struct({
  repository: Schema.Literal("https://github.com/tc39/test262"),
  commit: Schema.Literal("250f204f23a9249ff204be2baec29600faae7b75"),
  cases: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      upstream: Schema.String,
      sha256: Schema.String,
      asyncTest: Schema.Boolean,
    }),
  ),
});

// Kept independent of the manifest so removing entries cannot reduce coverage silently.
export const requiredCases = [
  [
    "fixtures/tdz.js",
    "test/language/statements/let/block-local-use-before-initialization-in-prior-statement.js",
    false,
  ],
  ["fixtures/var-hoisting.js", "test/language/statements/variable/S12.2_A1.js", false],
  ["fixtures/labeled-break.js", "test/language/statements/labeled/S12.12_A1_T1.js", false],
  ["fixtures/generator-return.js", "test/language/statements/generators/return.js", false],
  [
    "fixtures/generator-yield.js",
    "test/language/statements/generators/yield-as-statement.js",
    false,
  ],
  [
    "fixtures/for-await.js",
    "test/language/statements/for-await-of/async-func-dstr-const-ary-name-iter-val.js",
    true,
  ],
] as const;

export function validateCases(
  manifest: typeof Manifest.Type,
  sources: ReadonlyMap<string, string>,
) {
  if (manifest.cases.length === 0) throw new Error("Test262 selection must not be empty");
  for (const [file, upstream, asyncTest] of requiredCases) {
    const entry = manifest.cases.find((candidate) => candidate.file === file);
    if (!entry) throw new Error(`Missing required Test262 case: ${file}`);
    if (entry.upstream !== upstream || entry.asyncTest !== asyncTest) {
      throw new Error(`Test262 metadata mismatch: ${file}`);
    }
  }
  const seen = new Set<string>();
  return manifest.cases.map((entry) => {
    if (!/^fixtures\/[a-z-]+\.js$/.test(entry.file) || seen.has(entry.file)) {
      throw new Error(`Invalid or duplicate Test262 fixture: ${entry.file}`);
    }
    seen.add(entry.file);
    const source = sources.get(entry.file);
    if (source === undefined) throw new Error(`Missing Test262 fixture: ${entry.file}`);
    if (createHash("sha256").update(source).digest("hex") !== entry.sha256) {
      throw new Error(`Test262 checksum mismatch: ${entry.file}`);
    }
    return { ...entry, source };
  });
}

export function loadCases() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(
      fileURLToPath(new URL("./manifest.json", import.meta.url)),
    );
    const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(text);
    const sources = new Map<string, string>();
    for (const [file] of requiredCases) {
      sources.set(file, yield* fs.readFileString(fileURLToPath(new URL(file, import.meta.url))));
    }
    // Validate every fixture before executing any selected case. Invalid inventory is a test defect.
    return validateCases(manifest, sources);
  });
}

// Local, guest-interpreted subset of the Test262 harness, not upstream harness code.
// assert is an object because guest functions intentionally have no mutable properties.
const harness = `
const assert = {
  sameValue(actual, expected) {
    const equal = actual === expected ? (actual !== 0 || 1 / actual === 1 / expected) :
      (actual !== actual && expected !== expected);
    if (!equal) throw new Error('Test262 sameValue failed');
  },
  throws(expected, callback) {
    let caught = false;
    try { callback(); } catch (error) {
      caught = true;
      const name = expected === Error ? 'Error' :
        expected === TypeError ? 'TypeError' :
        expected === ReferenceError ? 'ReferenceError' :
        expected === RangeError ? 'RangeError' :
        expected === SyntaxError ? 'SyntaxError' :
        expected === URIError ? 'URIError' :
        expected === EvalError ? 'EvalError' :
        expected === AggregateError ? 'AggregateError' : undefined;
      if (name === undefined || !(error instanceof expected) || error.name !== name)
        throw new Error('Test262 wrong exception type');
    }
    if (!caught) throw new Error('Test262 expected exception');
  }
};
let test262DoneCount = 0;
function $DONE(error) {
  test262DoneCount++;
  if (test262DoneCount !== 1) throw new Error('Test262 duplicate completion');
  if (error !== undefined) throw error;
}
`;

export function runCase(entry: { source: string; asyncTest: boolean }) {
  const completion = entry.asyncTest
    ? `
for (let turn = 0; turn < 100 && test262DoneCount === 0; turn++) await Promise.resolve();
assert.sameValue(test262DoneCount, 1);
`
    : "";
  // Only the assertion failure constructor is adapted; checked-in fixture bytes stay intact.
  // The runtime deliberately does not allow arbitrary constructor aliases.
  const source = entry.source.replaceAll("new Test262Error(", "new Error(");
  return CodeMode.execute({
    tools: {},
    code: `${harness}\n${source}\n${completion}\nreturn true;`,
    limits: { timeoutMs: 2000, maxToolCalls: 0, maxOutputBytes: 4096 },
  });
}
