import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const RUNNER_NAME = /^run[A-Z]/u;

const exportedName = (name: ESTree.ModuleExportName): string =>
  name.type === "Identifier" ? name.name : name.value;

/**
 * Close the named-import gap in the `run*` property ban. `no-restricted-imports` cannot express
 * this because it also rejects every namespace import of a module with restricted names.
 */
export const noEffectRunnerImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow named imports and re-exports of `run*` runners from `effect/Effect`.",
    },
    messages: {
      runnerImport:
        "Keep Effect runners at named Pi host or standalone-process boundaries. Return the Effect to its caller or run it through the pi-cosmic-core session runtime.",
    },
  },
  createOnce(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect/Effect" || node.importKind === "type") return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.importKind !== "type" &&
            RUNNER_NAME.test(exportedName(specifier.imported))
          )
            context.report({ node: specifier, messageId: "runnerImport" });
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== "effect/Effect" || node.exportKind === "type") return;
        for (const specifier of node.specifiers) {
          if (specifier.exportKind !== "type" && RUNNER_NAME.test(exportedName(specifier.local)))
            context.report({ node: specifier, messageId: "runnerImport" });
        }
      },
    };
  },
});
