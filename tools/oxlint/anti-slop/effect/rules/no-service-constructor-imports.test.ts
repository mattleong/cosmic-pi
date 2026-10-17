import { RuleTester } from "oxlint/plugins-dev";

import { noServiceConstructorImportsRule } from "./no-service-constructor-imports.ts";

new RuleTester().run("no-service-constructor-imports", noServiceConstructorImportsRule, {
  valid: [
    {
      filename: "src/issue-service.test.ts",
      code: 'import { makeIssueService } from "./issue-service.ts";',
    },
    {
      filename: "src/runtime.ts",
      code: 'import { issueServiceLayer } from "./issue-service.ts";\nWorkspaceName.make("name");',
    },
  ],
  invalid: [
    {
      filename: "src/runtime.ts",
      code: 'import { makeIssueService as createIssueService } from "../issue-service.ts";',
      errors: [
        {
          messageId: "serviceConstructorImport",
          data: { name: "makeIssueService" },
        },
      ],
      output: null,
    },
  ],
});
