import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  importedMember,
  staticPropertyName,
  unwrapExpression,
  type RuntimeFunction,
} from "../../shared/ast.ts";

/** Match `Effect.gen(function* ...)` through any lexical alias of `effect/Effect`. */
const isEffectGenCall = (sourceCode: SourceCode, node: ESTree.Expression): boolean => {
  if (node.type !== "CallExpression") return false;
  const imported = importedMember(sourceCode, node.callee);
  // `Effect.gen({ self: this }, ...)` binds `this`, which Effect.fn cannot express.
  return (
    imported?.source === "effect/Effect" &&
    imported.name === "gen" &&
    node.arguments.length === 1 &&
    node.arguments[0]?.type === "FunctionExpression" &&
    node.arguments[0].generator
  );
};

/** Match `Effect.gen(...)`, optionally followed by `.pipe(...)` steps that Effect.fn accepts. */
const isEffectGenExpression = (sourceCode: SourceCode, expression: ESTree.Expression): boolean => {
  const node = unwrapExpression(expression);
  if (node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const { callee } = node;
    if (staticPropertyName(callee.property, callee.computed) === "pipe")
      return isEffectGenExpression(sourceCode, callee.object);
  }
  return isEffectGenCall(sourceCode, node);
};

/** Match a body that only builds an `Effect.gen`, with nothing evaluated eagerly before it. */
const isEffectGenBody = (sourceCode: SourceCode, fn: RuntimeFunction): boolean => {
  if (fn.async || fn.generator || fn.body === null) return false;
  if (fn.body.type !== "BlockStatement") return isEffectGenExpression(sourceCode, fn.body);
  const [statement, ...rest] = fn.body.body;
  return (
    rest.length === 0 &&
    statement?.type === "ReturnStatement" &&
    statement.argument !== null &&
    isEffectGenExpression(sourceCode, statement.argument)
  );
};

const memberName = (key: ESTree.Node, computed: boolean): string | null =>
  key.type === "PrivateIdentifier" ? key.name : staticPropertyName(key, computed);

/** Return the name a function is declared or bound under; inline callbacks have none. */
const boundName = (fn: RuntimeFunction): string | null => {
  if (fn.type === "FunctionDeclaration") return fn.id?.name ?? null;
  const parent = fn.parent;
  if (parent.type === "VariableDeclarator")
    return parent.init === fn && parent.id.type === "Identifier" ? parent.id.name : null;
  if (parent.type === "Property")
    return parent.value === fn && parent.kind === "init"
      ? memberName(parent.key, parent.computed)
      : null;
  if (parent.type === "PropertyDefinition")
    return parent.value === fn ? memberName(parent.key, parent.computed) : null;
  return null;
};

const isExport = (node: ESTree.Node): boolean =>
  node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";

const statementDeclaration = (statement: ESTree.Node): ESTree.Node | null | undefined => {
  if (statement.type === "ExportNamedDeclaration") return statement.declaration;
  if (statement.type === "ExportDefaultDeclaration") return statement.declaration;
  return statement;
};

/** Effect.fn yields a single signature, so overloaded declarations keep their form. */
const isOverloaded = (fn: ESTree.Function, name: string): boolean => {
  const owner = isExport(fn.parent) ? fn.parent.parent : fn.parent;
  if (owner === null) return false;
  if (owner.type !== "Program" && owner.type !== "BlockStatement" && owner.type !== "TSModuleBlock")
    return false;
  return owner.body.some((statement) => {
    const declaration = statementDeclaration(statement);
    return declaration?.type === "TSDeclareFunction" && declaration.id?.name === name;
  });
};

export const preferEffectFnRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Define named functions that only build an `Effect.gen` with `Effect.fn` instead.",
    },
    messages: {
      preferEffectFn:
        '`{{name}}` only wraps `Effect.gen`. Define it as `Effect.fn("Owner.{{name}}")(function* (...) { ... })` for a span and call-site trace, or `Effect.fnUntraced` on hot paths; pass `.pipe` steps as further arguments.',
    },
  },
  createOnce(context) {
    const check = (fn: RuntimeFunction) => {
      if (!isEffectGenBody(context.sourceCode, fn)) return;
      const name = boundName(fn);
      if (name === null) return;
      if (fn.type === "FunctionDeclaration" && isOverloaded(fn, name)) return;
      context.report({ node: fn, messageId: "preferEffectFn", data: { name } });
    };
    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
    };
  },
});
