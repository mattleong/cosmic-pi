import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeTypeOnlyTestsRule } from "./no-runtime-type-only-tests.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const vitest = `import { it, test, describe, expect, expectTypeOf, assertType } from 'vitest';`;
const fs = `import { readFileSync } from 'node:fs';`;
const typeError = { messageId: "runtimeTypeCheck" };
const sourceError = { messageId: "sourceSpelling" };

tester.run("anti-slop/no-runtime-type-only-tests", noRuntimeTypeOnlyTestsRule, {
  valid: [
    {
      filename: "/repo/packages/pi-example/tests/contract.test-d.ts",
      code: `${vitest} test('contract', () => { expectTypeOf<Result>().toEqualTypeOf<Expected>(); assertType<Result>(value); });`,
    },
    `${vitest} it('value', () => { type Shape = { name: string }; const value: Shape = { name: 'a' }; expect(value.name).toBe('a'); });`,
    `${vitest} ${fs} it('fixture', () => expect(readFileSync('../fixtures/src/input.ts', 'utf8')).toContain('export const answer'));`,
    `${vitest} ${fs} it('parser', () => expect(parse(readFileSync('../src/input.ts', 'utf8'))).toEqual('export const answer'));`,
  ],
  invalid: [
    {
      code: `${vitest} it('contract', () => expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
      errors: [typeError],
    },
    {
      name: "@effect/vitest re-exports Vitest's type assertions",
      code: `import { expectTypeOf, it } from '@effect/vitest'; it('contract', () => expectTypeOf<Result>().toEqualTypeOf<Expected>());`,
      errors: [typeError],
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
  ],
});
