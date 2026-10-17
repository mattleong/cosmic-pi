import { RuleTester } from "oxlint/plugins-dev";

import { noArrayFilterMapRule } from "./no-array-filter-map.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "arrayFilterMap" };

tester.run("anti-slop/no-array-filter-map", noArrayFilterMapRule, {
  valid: [
    "const users = []; users.values().filter(active).map(email).toArray();",
    "const users = []; users.flatMap(user => user.active ? [user.email] : []);",
    "function collect(unknownReceiver) { return unknownReceiver.filter(active).map(email); }",
  ],
  invalid: [
    { code: "[].filter(active).map(email);", errors: [error] },
    { code: "const users = []; users.map(email).filter(Boolean);", errors: [error] },
    {
      code: "function collect(users: readonly User[]) { return users.map(email).filter(present); }",
      errors: [error],
    },
  ],
});
