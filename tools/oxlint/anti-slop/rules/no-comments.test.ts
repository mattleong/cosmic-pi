import { RuleTester } from "oxlint/plugins-dev";

import { noCommentsRule } from "./no-comments.ts";

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const error = { messageId: "comment" };

tester.run("anti-slop/no-comments", noCommentsRule, {
  valid: [
    "const url = 'https://example.com/path';",
    "const text = '// not a comment';",
    "const pattern = /\\/\\*.*\\*\\//u;",
    "const template = `/* still text */`;",
    "#!/usr/bin/env node\nconsole.log(1);",
  ],
  invalid: [
    {
      name: "own-line comment removes its line",
      code: "const a = 1;\n  // note\nconst b = 2;\n",
      output: "const a = 1;\nconst b = 2;\n",
      errors: [error],
    },
    {
      name: "trailing comment keeps the code",
      code: "const a = 1; // note\nconst b = 2;\n",
      output: "const a = 1;\nconst b = 2;\n",
      errors: [error],
    },
    {
      name: "doc block removes every line",
      code: "/**\n * Docs.\n */\nexport const a = 1;\n",
      output: "export const a = 1;\n",
      errors: [error],
    },
    {
      name: "inline block keeps separated tokens apart",
      code: "const a = typeof/* why */value;",
      output: "const a = typeof value;",
      errors: [error],
    },
    {
      name: "keyword separation survives trailing spaces",
      code: "const a = typeof/* note */ value;",
      output: "const a = typeof value;",
      errors: [error],
    },
    {
      name: "numeric tokens do not absorb member punctuation",
      code: "const text = 1/* note */.toString();",
      output: "const text = 1 .toString();",
      errors: [error],
    },
    {
      name: "operators do not become an update expression",
      code: "const sum = left+/* note */+right;",
      output: "const sum = left+ +right;",
      errors: [error],
    },
    {
      name: "operator separation survives trailing spaces",
      code: "const sum = left+/* note */ +right;",
      output: "const sum = left+ +right;",
      errors: [error],
    },
    {
      name: "division does not become a line comment",
      code: "const ratio = value/ /* note *//pattern/.source.length;",
      output: "const ratio = value/ /pattern/.source.length;",
      errors: [error],
    },
    {
      name: "multiline return preserves automatic semicolon insertion",
      code: "function read() { return/*\n note */value; }",
      output: "function read() { return\nvalue; }",
      errors: [error],
    },
    {
      name: "multiline postfix update preserves its statement boundary",
      code: "let value = 1; value/*\n note */++value;",
      output: "let value = 1; value\n++value;",
      errors: [error],
    },
    {
      name: "carriage return preserves automatic semicolon insertion",
      code: "function read() { return/*\r note */value; }",
      output: "function read() { return\rvalue; }",
      errors: [error],
    },
    {
      name: "unicode line separator preserves automatic semicolon insertion",
      code: "function read() { return/*\u2028 note */value; }",
      output: "function read() { return\u2028value; }",
      errors: [error],
    },
    {
      name: "inline block beside punctuation",
      code: "call(/* first */ a, b);",
      output: "call(a, b);",
      errors: [error],
    },
    {
      name: "comment after shebang",
      code: "#!/usr/bin/env node\n// note\nrun();\n",
      output: "#!/usr/bin/env node\nrun();\n",
      errors: [error],
    },
    {
      name: "consecutive own-line comments",
      code: "// one\n// two\nrun();\n",
      output: "run();\n",
      errors: [error, error],
    },
  ],
});
