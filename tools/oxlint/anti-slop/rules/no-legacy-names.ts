import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const retiredPathTerm = /legacy|deprecated|(?:^|[^a-z0-9])back(?:wards?)?_?compat/u;

function words(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .toLowerCase();
}

function namesRetiredPath(name: string): boolean {
  return retiredPathTerm.test(words(name));
}

export const noCompatibilityPathNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow names that mark legacy, deprecated, or backwards-compatibility paths.",
    },
    messages: {
      retiredPathName:
        "`{{name}}` names a backwards-compatibility path, and this repo keeps none. Delete the old path, or rename it for the role it serves now.",
    },
  },
  createOnce(context) {
    const reported = new Set<number>();
    const check = (node: ESTree.Node & { readonly name: string }) => {
      if (reported.has(node.start) || !namesRetiredPath(node.name)) return;
      reported.add(node.start);
      context.report({ node, messageId: "retiredPathName", data: { name: node.name } });
    };
    return {
      before() {
        reported.clear();
      },
      Identifier: check,
      PrivateIdentifier: check,
    };
  },
});
