import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeOnlyTestsRule } from "./no-runtime-type-only-tests.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const vitest = `import { it, test, describe, expect, expectTypeOf, assertType } from 'vitest';`;
const fs = `import { readFileSync } from 'node:fs';`;
const typeError = { messageId: "runtimeTypeCheck" };
const sourceError = { messageId: "sourceSpelling" };

tester.run("anti-slop/no-runtime-type-only-tests", noRuntimeTypeOnlyTestsRule, {
  valid: [
    `${vitest} expectTypeOf<Result>().toEqualTypeOf<Expected>(); assertType<Result>(value);`,
    // Vitest's typecheck mode collects these files and never runs their test callbacks.
    {
      filename: "/repo/packages/pi-example/tests/contract.test-d.ts",
      code: `${vitest} test('contract', () => { expectTypeOf<Result>().toEqualTypeOf<Expected>(); assertType<Result>(value); });`,
    },
    {
      filename: "/repo/packages/pi-example/tests/contract.spec-d.mts",
      code: `${vitest} describe('contracts', () => { it('contract', () => expectTypeOf<Result>().toEqualTypeOf<Expected>()); });`,
    },
    `${vitest} it('value', () => { type Shape = { name: string }; const value: Shape = { name: 'a' }; expect(value.name).toBe('a'); });`,
    `${vitest} it('value', () => { const expectTypeOf = (value) => expect(value); expectTypeOf(1).toBe(1); });`,
    `${vitest} function local(it) { it('callback', () => assertType<Result>(value)); }`,
    `import { expectTypeOf, assertType } from './runtime-checks'; import { it } from 'vitest'; it('value', () => { expectTypeOf(value); assertType(value); });`,
    `import { expectTypeOf } from 'vitest'; import { it } from './callbacks'; it('value', () => expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
    `import type { expectTypeOf, assertType } from 'vitest'; it('value', () => { expectTypeOf<Result>(); assertType<Result>(value); });`,
    `import { type expectTypeOf } from 'vitest'; it('value', () => expectTypeOf<Result>());`,
    `${vitest} describe('contracts', () => expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
    // Fixture/parser/compiler tests and module execution are behavior, not source spellings.
    `${vitest} it('parser', () => expect(parse('import { x } from "x"')).toEqual({ kind: 'import' }));`,
    `${vitest} ${fs} it('fixture', () => expect(readFileSync('../fixtures/src/input.ts', 'utf8')).toContain('export const answer'));`,
    `${vitest} ${fs} it('parser', () => expect(parse(readFileSync('../src/input.ts', 'utf8'))).toEqual('export const answer'));`,
    `${vitest} ${fs} it('compiler', () => expect(compile(readFileSync('../src/input.ts', 'utf8')).output).toContain('export const answer'));`,
    `${vitest} ${fs} it('packaging', () => expect(readFileSync('../dist/index.js', 'utf8')).toContain('from "./public.js"'));`,
    `${vitest} it('Jiti', async () => expect(await jiti.import('../src/protocol.ts')).toHaveProperty('encode'));`,
    // Ordinary FS assertions, arbitrary strings/regexes, and shadowed read/expect APIs stay valid.
    `${vitest} ${fs} it('stored file', () => expect(readFileSync('/tmp/result.txt', 'utf8')).toBe('export const answer'));`,
    `${vitest} ${fs} it('source contents', () => expect(readFileSync('../src/protocol.ts', 'utf8')).toContain('license'));`,
    `${vitest} ${fs} it('source contents', () => expect(readFileSync('../src/protocol.ts', 'utf8')).not.toMatch(/task\\/model|backend/));`,
    `${vitest} it('text', () => expect('from "./module"').toContain('from "./module"'));`,
    `${vitest} import { readFileSync } from './fixtures'; it('text', () => expect(readFileSync('../src/protocol.ts')).toContain('from "./module"'));`,
    `${vitest} ${fs} it('shadowed reader', () => { const readFileSync = () => 'fixture'; expect(readFileSync('../src/protocol.ts')).toContain('from "./module"'); });`,
    `${vitest} ${fs} it('shadowed expect', () => { const expect = customMatcher; expect(readFileSync('../src/protocol.ts')).toContain('from "./module"'); });`,
    `${vitest} function check(process) { const fs = process.getBuiltinModule('node:fs'); expect(fs.readFileSync('../src/protocol.ts')).toContain('from "./module"'); }`,
    `${vitest} ${fs} const source = readFileSync(dynamicPath, 'utf8'); expect(source).toContain('from "./module"');`,
    `${vitest} ${fs} let source = readFileSync('../src/protocol.ts', 'utf8'); source = fixture; expect(source).toContain('from "./module"');`,
    `${vitest} ${fs} const readSource = (path) => transform(readFileSync(path, 'utf8')); expect(readSource('../src/protocol.ts')).toContain('from "./module"');`,
    `${vitest} ${fs} function readSource(path) { return readFileSync(path, 'utf8'); } readSource = fixtureReader; expect(readSource('../src/protocol.ts')).toContain('from "./module"');`,
    `${vitest} ${fs} it('fixture URL', () => { const URL = FakeURL; expect(readFileSync(new URL('../src/protocol.ts', import.meta.url))).toContain('from "./module"'); });`,
  ],
  invalid: [
    {
      code: `${vitest} it('contract', () => expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
      errors: [typeError],
    },
    {
      code: `${vitest} test('contract', () => assertType<Result>(value));`,
      errors: [typeError],
    },
    {
      name: "import aliases and parameterized runtime tests",
      code: `import { test as check, expectTypeOf as typeOf } from 'vitest'; check.each([1])('contract', () => typeOf<Result>().toEqualTypeOf<Expected>());`,
      errors: [typeError],
    },
    {
      name: "Effect test callback",
      code: `import { it as effectTest } from '@effect/vitest'; import { assertType as checkType } from 'vitest'; effectTest.effect('contract', () => Effect.sync(() => checkType<Result>(value)));`,
      errors: [typeError],
    },
    {
      name: "@effect/vitest re-exports Vitest's type assertions",
      code: `import { expectTypeOf, it } from '@effect/vitest'; it('contract', () => expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
      errors: [typeError],
    },
    {
      name: "a test-d spelling in an ordinary test file is still a runtime test",
      filename: "/repo/packages/pi-example/tests/contract-d.test.ts",
      code: `${vitest} it('contract', () => expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
      errors: [typeError],
    },
    {
      name: "namespace imports and global runtime registration",
      code: `import * as v from 'vitest'; test('contract', () => v.expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
      errors: [typeError],
    },
    {
      name: "multiple erased checks remain individual diagnostics",
      code: `${vitest} it.only('contract', () => { expectTypeOf<Result>().toEqualTypeOf<Expected>(); assertType<Result>(value); });`,
      errors: [typeError, typeError],
    },
    {
      name: "direct production import spelling",
      code: `${vitest} ${fs} it('protocol', () => expect(readFileSync('../src/protocol.ts', 'utf8')).toContain('from "./output-size.ts"'));`,
      errors: [sourceError],
    },
    {
      name: "historical process builtin readSource helper",
      code: `${vitest}
        const fs = process.getBuiltinModule('node:fs');
        const readSource = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
        const publicProtocol = readSource('../src/protocol.ts');
        it('protocol', () => {
          expect(publicProtocol).toContain('from "./code-mode/output-size.ts"');
          expect(publicProtocol).not.toMatch(/task\\/model|backend/);
        });`,
      errors: [sourceError],
    },
    {
      name: "aliased imports and const source aliases",
      code: `import { expect as check, it } from 'vitest'; import { readFileSync as read } from 'node:fs'; const path = '../src/protocol.ts'; const source = read(path, 'utf8'); const alias = source; it('protocol', () => check(alias).not.toContain('export interface Protocol'));`,
      errors: [sourceError],
    },
    {
      name: "namespace fs, function wrapper, and declaration spelling",
      code: `${vitest} import * as fs from 'node:fs'; function read(path: string) { return fs.readFileSync(new URL(path, import.meta.url), 'utf8'); } it('protocol', () => expect(read('../src/protocol.ts')).toMatch(/interface Protocol/));`,
      errors: [sourceError],
    },
    {
      name: "awaited raw source remains a spelling assertion",
      code: `${vitest} import { readFile } from 'node:fs/promises'; it('source', async () => { const source = await readFile('../src/protocol.ts', 'utf8'); expect(source).toContain('import {'); });`,
      errors: [sourceError],
    },
    {
      name: "source spelling at top level",
      code: `${vitest} import fs from 'node:fs'; expect(fs.readFileSync('../src/protocol.ts', 'utf8')).toContain('export type Protocol');`,
      errors: [sourceError],
    },
  ],
});
