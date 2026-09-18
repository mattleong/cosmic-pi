# Runtime support

This is a confined orchestration language, not a general ECMAScript engine. Parsing
JavaScript syntax does not imply support for every operation on that syntax. The
runtime interprets guest code; it never evaluates it with host `eval` or `Function`.

## Compatibility matrix

The matrix records implemented behavior and its regression suites. It is not a
claim of general ECMAScript conformance.

| Area                              | Contract and limits                                                                                                                                                       | Evidence                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Data and expressions              | Literals, sparse arrays, destructuring, spread, optional chaining, templates, arithmetic and comparison; guarded own-property access, not host prototypes                 | `javascript-compat.test.ts`, `object-compat.test.ts`, `parity.test.ts`                                                             |
| Control flow                      | Conditions, switch, loops, try/catch/finally, functions and closures                                                                                                      | `codemode.test.ts`, `parity.test.ts`                                                                                               |
| Lexical bindings, upgrade         | TDZ before `let`/`const` initialization, function-scope `var` hoisting, labeled break and continue                                                                        | `lexical.test.ts`, `var-hoisting.test.ts`, `labeled-control.test.ts`, Test262 selection                                            |
| Async iteration, upgrade          | `for await...of` over admitted async and synchronous iterables, including awaiting synchronous iterator values and closing on abrupt exits                                | `for-await.test.ts`, Test262 selection                                                                                             |
| Generators and iterators, upgrade | Sync and async generators; `yield`, `yield*`, `next`, `return`, `throw`; admitted custom sync/async iterators and consumer integration                                    | `generators.test.ts`, `async-generators.test.ts`, `generator-cleanup.test.ts`, `iterators.test.ts`, `iterator-confinement.test.ts` |
| Async functions and promises      | Await, eager activations, FIFO reactions, adoption, then/catch/finally, all/allSettled/any/race/resolve/reject; no Promise constructor or arbitrary thenable assimilation | `async-function.test.ts`, `async-scheduling.test.ts`, `promise*.test.ts`                                                           |
| Arrays and collections            | Allowlisted methods, Array.from mapper, Map/Set/URLSearchParams, grouping, Set algebra over owned Set/Map operands; no arbitrary set-like operands                        | `array-from.test.ts`, `callback-compat.test.ts`, `group-by.test.ts`, `set-operations.test.ts`                                      |
| JSON                              | Replacers, property lists and revivers; callbacks not implicitly awaited; no custom toJSON, callback this or reviver source context                                       | `json-callbacks.test.ts`                                                                                                           |
| Standard library                  | Allowlisted Object, Math, Number, String, Date, RegExp, URL, URI and console operations; not complete native APIs                                                         | `stdlib.test.ts`, `src/stdlib/` allowlists                                                                                         |
| Catalog snapshot/delta, upgrade   | Host runtime API for semantic tool catalog snapshots/deltas; not a new guest tool or a Pi registry/discovery grant                                                        | `catalog-updates.test.ts`                                                                                                          |
| Interpreter module split, upgrade | Internal responsibility split, not a new execution boundary or language guarantee                                                                                         | `ARCHITECTURE.md`, retained runtime regression suites                                                                              |
| Test262                           | Six pinned positive cases, all mandatory in ordinary runtime tests; not a full Test262 runner or broad ECMAScript conformance                                             | `tests/test262.test.ts`, manifest and fixture checksums                                                                            |

## Assignment and binding patterns

Assignment resolves member bases and computed keys once, before evaluating its right-hand
side. Compound assignment reads the old value before that evaluation; logical assignments
skip it when their condition does not require a write. Array and object destructuring
assignments support nested targets, defaults, rest and computed object keys. Array patterns
consume admitted iterators, including bytes, and close them on early completion or failure.
Binding patterns also accept computed object keys. Existing blocked-key, cycle and growth
checks still apply. See `assignment.test.ts`, `destructuring-assignment.test.ts` and
`feature-composition.test.ts`.

## Bytes and text

These are owned interpreter values, not host typed-array or buffer capabilities:

- `new Uint8Array()` accepts a length, owned bytes, or an admitted iterable. Bytes expose
  indexed reads/writes, `length`, `byteLength`, iteration, `at`, `set`, `slice`, `subarray`,
  `toBase64` and `toHex`. `slice` copies; `subarray` may share owned internal storage.
  No backing `ArrayBuffer`, `DataView`, Buffer or host prototype is exposed.
- `Uint8Array.fromBase64` and `fromHex` decode strings. Base64 uses the standard alphabet,
  mandatory padding where needed and canonical trailing bits, without whitespace or URL-safe
  variants. Hex requires an even number of digits, accepts either case and emits lowercase.
  Encoding options are not supported.
- `new TextEncoder().encode(text)` produces UTF-8 bytes, replacing lone surrogates.
  `new TextDecoder(label, { fatal, ignoreBOM }).decode(bytes)` accepts UTF-8 labels only.
  Flags must be booleans. There is no streaming or `encodeInto`.
- `btoa` encodes Latin-1 binary strings; use TextEncoder for Unicode. `atob` returns a binary
  string and uses the same strict base64 subset.

Byte allocations use the fixed collection cap of 262,144 entries. Text uses the existing
4,194,304 UTF-16-code-unit cap. UTF-8 encoding counts exact output bytes before allocation;
base64 and hex preflight decoded and encoded lengths. These are per-operation bounds, not
an aggregate heap quota. Bytes and encoder/decoder objects cannot cross tool-input,
tool-result or final-return data boundaries, including bytes nested in arrays or records.
Encode bytes to a string first; refusal diagnostics explain this requirement.
`JSON.stringify(bytes)` produces a string with numeric object properties. Existing Map/Set
boundary projection remains `{}`, not a transfer of their members. The helpers add no fetch,
crypto or other ambient authority. See `bytes.test.ts`, `encoding.test.ts`,
`bytes-confinement.test.ts` and
`feature-composition.test.ts`.

## Namespace and schema discovery

Hosts may wrap a plain tool tree with `Namespace.make({ tools, description })`. The optional
description contributes to descendant search matches and budgeted catalog metadata, never to
guest properties or callable authority. Plain trees remain supported. Namespace topology and
metadata changes can require a replacement snapshot, while signatures retain round-robin
budget selection. Search retains full signatures for tools omitted from the initial catalog.

Pretty signatures show JSON Schema constraints as documentation on inputs, nested values and
outputs: numeric minimum/maximum, exclusive bounds and multipleOf; string length and pattern;
array length and uniqueItems; object property counts; integer, format, default and deprecated
annotations. Enum and const values remain literal types. Unsupported or unresolved references
fall back to `unknown`; comment terminators are escaped. Compact signatures omit annotations.
Raw JSON Schema is render-only, not validation. Effect Schemas still decode inputs and outputs;
hosts using raw JSON Schema must enforce constraints themselves. See `schema-discovery.test.ts`
and `namespace-discovery.test.ts`.

## Deliberate restrictions

No modules/imports, classes, dynamic `this`, host prototype access, arbitrary
constructors, eval, timers, fetch, crypto, process, ambient filesystem or network APIs.
Only explicit host-supplied tools grant external authority. Interpreter confinement
does not undo or sandbox the effects of those tools.

Callbacks use interpreter dispatch. Most collection and JSON callbacks do not await
returned promises. Async iteration has its own awaiting rules. Returned dates and URLs
serialize to strings; Maps, Sets, RegExps and URLSearchParams serialize to `{}`.
Opaque functions, promises and iterators are not data-boundary capabilities.

Synchronous guest call depth is fixed at 128 across ordinary calls, async prefixes, callbacks
and generator resumes. A semantic await resets depth for its continuation; this is not a total
call quota. The conservative bound accounts for local immediate Effect activation forks without
changing FIFO scheduling. No public option changes it; smaller injected budgets exist only in
internal tests. See `recursion.test.ts`.

Tool concurrency stays 8 and data-boundary depth stays 32. String, collection and
captured-log caps, conservative regex screening, bounded serialization and cooperative
deadline checks remain in force. Valid JavaScript may be refused by these limits.
Native synchronous operations cannot be interrupted once entered. See `PROVENANCE.md`
for exact confinement rules and the host boundary for execution budgets.

## Mandatory Test262 selection

`pnpm --filter pi-code-mode-runtime test` discovers the suite without a download,
environment variable or separate checkout. The six repository fixtures are unchanged
bytes from tc39/test262 commit `250f204f23a9249ff204be2baec29600faae7b75`.
The manifest records upstream paths and SHA-256 checksums. Missing files, mismatched
checksums, empty or reduced selections, and upstream-path or async-flag mismatches
fail the ordinary test run against an independent required inventory before any
selected fixture executes, rather than skipping cases.
The license is in `tests/LICENSE.test262`.

The selection covers TDZ reads, var hoisting, a labeled break, generator return/yield,
and for-await destructuring of a synchronous array. It does not cover the whole upgrade,
strict/sloppy variants, negative parser cases, realm semantics or every iterator-close path.
Local regression suites cover behavior outside this selection.

The runner prepends guest-interpreted `assert.sameValue`, `assert.throws` and `$DONE`
helpers. Its assert is a plain object, not a mutable function. It substitutes only
`new Test262Error(` with `new Error(` in the execution copy, because arbitrary constructor
aliases are unsupported. Fixture bytes and their checksums are never rewritten.
Async completion must call `$DONE` once within 100 guest promise turns and the execution
deadline; a second call fails even during the final promise drain. `assert.throws`
requires both the expected error brand and its exact name, not a base-type match.
Runner failure cases are covered in `tests/test262-runner.test.ts` without repository
file mutation. The runner exposes no host assertion functions, tools or production harness
globals and never executes fixture source in the host JavaScript engine.
