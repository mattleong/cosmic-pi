import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  constValue,
  isRuntimeFunction,
  staticPropertyName,
  unwrapExpression,
} from "../shared/ast.ts";
import {
  containsUnknownType,
  functionParameterBindingName,
  functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";

type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function isTypePredicateSubject(owner: ParameterOwner, parameterName: string): boolean {
  const predicate = owner.returnType?.typeAnnotation;
  return (
    predicate?.type === "TSTypePredicate" &&
    predicate.parameterName.type === "Identifier" &&
    predicate.parameterName.name === parameterName
  );
}

/** Match `Schema.decodeUnknown*(schema)` or `Schema.is(schema)`, directly or through a const alias. */
function isSchemaDecoder(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const value = unwrapExpression(expression);
  if (value.type === "Identifier") {
    const init = constValue(sourceCode, value);
    return init !== null && isSchemaDecoder(sourceCode, init);
  }
  if (value.type !== "CallExpression") return false;
  const callee = unwrapExpression(value.callee);
  if (callee.type !== "MemberExpression") return false;
  const namespace = unwrapExpression(callee.object);
  const name = staticPropertyName(callee.property, callee.computed);
  return (
    namespace.type === "Identifier" &&
    namespace.name === "Schema" &&
    name !== null &&
    (name === "is" || name.startsWith("decodeUnknown"))
  );
}

/** Unknown input is honest when its first read hands it straight to a Schema decoder or guard. */
function isDecodedBySchema(
  sourceCode: SourceCode,
  owner: ParameterOwner,
  parameterName: string,
): boolean {
  if (!isRuntimeFunction(owner)) return false;
  const variable = sourceCode
    .getDeclaredVariables(owner)
    .find((candidate) => candidate.name === parameterName);
  const firstRead = variable?.references
    .filter((reference) => reference.isRead())
    .toSorted((left, right) => left.identifier.start - right.identifier.start)[0];
  const call = firstRead?.identifier.parent;
  return (
    call?.type === "CallExpression" &&
    call.arguments[0] === firstRead?.identifier &&
    isSchemaDecoder(sourceCode, call.callee)
  );
}

/** Disallow unknown inputs except error causes, type-predicate subjects, and Schema decoding. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`, type-predicate subjects, and input passed straight to a Schema decoder; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type, or pass the value straight to `Schema.decodeUnknown*` or `Schema.is` before any other use.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      for (const parameter of node.params) {
        const annotation = functionParameterTypeAnnotation(parameter);
        if (annotation === null || annotation === undefined) continue;
        if (!containsUnknownType(annotation.typeAnnotation)) continue;
        const name = functionParameterBindingName(parameter, context.sourceCode);
        if (
          name === "cause" ||
          isTypePredicateSubject(node, name) ||
          isDecodedBySchema(context.sourceCode, node, name)
        )
          continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
