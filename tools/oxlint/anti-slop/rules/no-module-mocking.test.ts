import { RuleTester } from "oxlint/plugins-dev";

import { noModuleMockingRule } from "./no-module-mocking.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "moduleMock" };

tester.run("anti-slop/no-module-mocking", noModuleMockingRule, {
  valid: [
    "const store = new InMemoryUserStore();",
    "vi.spyOn(store, 'save');",
    "const vi = { mock() {} }; vi.mock();",
    "function test(jest: { mock(): void }) { jest.mock(); }",
    "import { vi as localVi } from './helpers'; localVi.mock('./module');",
    "import * as v from './helpers'; v.vi.mock('./module');",
    "import * as v from 'vitest'; function test(v) { v.vi.mock('./module'); }",
    "import { vi } from 'vitest'; function test(vi) { const api = vi; api.mock('./module'); }",
    "import type { vi } from 'vitest'; vi.mock('./module');",
    "import { vi } from 'vitest'; let api = vi; api = fake; api.mock('./module');",
    "import { vi } from 'vitest'; const api = vi; api.spyOn(store, 'save');",
    "const vi = { mock() {} }; const api = vi; api.mock();",
    "const api = other; const other = api; api.mock();",
  ],
  invalid: [
    { code: "vi.mock('./user-store');", errors: [error] },
    { code: "jest.mock('./user-store');", errors: [error] },
    { code: "vi['doMock']('./user-store');", errors: [error] },
    { code: "jest.unstable_mockModule('./user-store');", errors: [error] },
    { code: "import { vi } from 'vitest'; vi.mock('./user-store');", errors: [error] },
    {
      code: "import { vi as testApi } from 'vitest'; testApi.mock('./user-store');",
      errors: [error],
    },
    { code: "import * as v from 'vitest'; v.vi.mock('./module');", errors: [error] },
    { code: "import { vi } from '@effect/vitest'; vi.doMock('./module');", errors: [error] },
    { code: "import * as v from '@effect/vitest'; v.vi.mock('./module');", errors: [error] },
    { code: "import * as j from '@jest/globals'; j.jest.mock('./module');", errors: [error] },
    { code: "import { vi } from 'vitest'; const api = vi; api.mock('./module');", errors: [error] },
    {
      code: "import * as v from 'vitest'; const api = v.vi; const alias = api; alias['mock']('./module');",
      errors: [error],
    },
    { code: "const api = vi; api.mock('./module');", errors: [error] },
    { code: "import { vi } from 'vitest'; vi?.mock('./module');", errors: [error] },
    {
      code: "import { jest } from '@jest/globals'; jest.mock('./user-store');",
      errors: [error],
    },
  ],
});
