import type { AnyNode } from "acorn";

export type SyntaxNodeType = AnyNode["type"];
export type SyntaxNode<Type extends SyntaxNodeType> = Extract<AnyNode, { readonly type: Type }>;

export function syntaxNodeGuard<const Types extends readonly SyntaxNodeType[]>(
  types: Types,
): (node: AnyNode) => node is SyntaxNode<Types[number]> {
  const members: ReadonlySet<SyntaxNodeType> = new Set(types);
  return (node): node is SyntaxNode<Types[number]> => members.has(node.type);
}

export function unhandledSyntax(node: never): never {
  throw new Error("Unhandled syntax node", { cause: node });
}

const present = <T>(value: T | null | undefined): T[] =>
  value === null || value === undefined ? [] : [value];

const SEQUENCE_TYPES = [
  "Program",
  "BlockStatement",
  "StaticBlock",
  "ClassBody",
  "ExpressionStatement",
  "ChainExpression",
  "ParenthesizedExpression",
  "LabeledStatement",
  "VariableDeclaration",
  "VariableDeclarator",
  "SequenceExpression",
  "TemplateLiteral",
] as const;
const OPERATOR_TYPES = [
  "ReturnStatement",
  "ThrowStatement",
  "UnaryExpression",
  "UpdateExpression",
  "AwaitExpression",
  "YieldExpression",
  "SpreadElement",
  "RestElement",
  "BinaryExpression",
  "LogicalExpression",
  "AssignmentExpression",
  "AssignmentPattern",
  "ConditionalExpression",
] as const;
const ACCESS_TYPES = [
  "CallExpression",
  "NewExpression",
  "MemberExpression",
  "TaggedTemplateExpression",
  "ImportExpression",
  "ArrayExpression",
  "ArrayPattern",
  "ObjectExpression",
  "ObjectPattern",
  "Property",
] as const;
const CONTROL_TYPES = [
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "SwitchCase",
  "TryStatement",
  "CatchClause",
] as const;
const DEFINITION_TYPES = [
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "MethodDefinition",
  "PropertyDefinition",
] as const;

const isSequenceNode = syntaxNodeGuard(SEQUENCE_TYPES);
const isOperatorNode = syntaxNodeGuard(OPERATOR_TYPES);
const isAccessNode = syntaxNodeGuard(ACCESS_TYPES);
const isControlNode = syntaxNodeGuard(CONTROL_TYPES);
const isDefinitionNode = syntaxNodeGuard(DEFINITION_TYPES);

function sequenceChildren(node: SyntaxNode<(typeof SEQUENCE_TYPES)[number]>): readonly AnyNode[] {
  switch (node.type) {
    case "Program":
    case "BlockStatement":
    case "StaticBlock":
    case "ClassBody":
      return node.body;
    case "ExpressionStatement":
    case "ChainExpression":
    case "ParenthesizedExpression":
      return [node.expression];
    case "LabeledStatement":
      return [node.body];
    case "VariableDeclaration":
      return node.declarations;
    case "VariableDeclarator":
      return [node.id, ...present(node.init)];
    case "SequenceExpression":
    case "TemplateLiteral":
      return node.expressions;
  }
  return unhandledSyntax(node);
}

function operatorChildren(node: SyntaxNode<(typeof OPERATOR_TYPES)[number]>): readonly AnyNode[] {
  switch (node.type) {
    case "ReturnStatement":
    case "ThrowStatement":
    case "UnaryExpression":
    case "UpdateExpression":
    case "AwaitExpression":
    case "YieldExpression":
    case "SpreadElement":
    case "RestElement":
      return present(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
    case "AssignmentExpression":
    case "AssignmentPattern":
      return [node.left, node.right];
    case "ConditionalExpression":
      return [node.test, node.consequent, node.alternate];
  }
  return unhandledSyntax(node);
}

function accessChildren(node: SyntaxNode<(typeof ACCESS_TYPES)[number]>): readonly AnyNode[] {
  switch (node.type) {
    case "CallExpression":
    case "NewExpression":
      return [node.callee, ...node.arguments];
    case "MemberExpression":
      return node.computed ? [node.object, node.property] : [node.object];
    case "TaggedTemplateExpression":
      return [node.tag, node.quasi];
    case "ImportExpression":
      return [node.source, ...present(node.options)];
    case "ArrayExpression":
    case "ArrayPattern":
      return node.elements.filter((element) => element !== null);
    case "ObjectExpression":
    case "ObjectPattern":
      return node.properties;
    case "Property":
      return node.computed ? [node.key, node.value] : [node.value];
  }
  return unhandledSyntax(node);
}

function controlChildren(node: SyntaxNode<(typeof CONTROL_TYPES)[number]>): readonly AnyNode[] {
  switch (node.type) {
    case "IfStatement":
      return [node.test, node.consequent, ...present(node.alternate)];
    case "ForStatement":
      return [...present(node.init), ...present(node.test), ...present(node.update), node.body];
    case "ForInStatement":
    case "ForOfStatement":
      return [node.left, node.right, node.body];
    case "WhileStatement":
    case "DoWhileStatement":
      return [node.test, node.body];
    case "SwitchStatement":
      return [node.discriminant, ...node.cases];
    case "SwitchCase":
      return [...present(node.test), ...node.consequent];
    case "TryStatement":
      return [node.block, ...present(node.handler), ...present(node.finalizer)];
    case "CatchClause":
      return [...present(node.param), node.body];
  }
  return unhandledSyntax(node);
}

function definitionChildren(
  node: SyntaxNode<(typeof DEFINITION_TYPES)[number]>,
): readonly AnyNode[] {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return [...present(node.id), ...node.params, node.body];
    case "ClassDeclaration":
    case "ClassExpression":
      return [...present(node.id), ...present(node.superClass), node.body];
    case "MethodDefinition":
    case "PropertyDefinition":
      return [...(node.computed ? [node.key] : []), ...present(node.value)];
  }
  return unhandledSyntax(node);
}

export function syntaxChildren(node: AnyNode): readonly AnyNode[] {
  if (isSequenceNode(node)) return sequenceChildren(node);
  if (isOperatorNode(node)) return operatorChildren(node);
  if (isAccessNode(node)) return accessChildren(node);
  if (isControlNode(node)) return controlChildren(node);
  if (isDefinitionNode(node)) return definitionChildren(node);
  return [];
}
