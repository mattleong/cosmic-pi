import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import {
  importedMember,
  isRuntimeFunction,
  isStringLiteral,
  staticPropertyName,
  unwrapExpression,
  type RuntimeFunction,
} from "../shared/ast.ts";

type Path = readonly string[];

/** What a predicate claims about its subject, and where that claim is written. */
interface Claim {
  readonly subject: string;
  readonly type: ESTree.TSType;
  readonly report: ESTree.Node;
  /** The subject's declared type parameter, such as `V` in `(v: V): v is V & T`. */
  readonly inputType: string | null;
  readonly typeParameters: ReadonlySet<string>;
}

type LocalTypeDeclaration = ESTree.TSTypeAliasDeclaration | ESTree.TSInterfaceDeclaration;

interface TypeEnvironment {
  readonly claim: Claim;
  readonly declarations: (name: string) => readonly LocalTypeDeclaration[];
  readonly seen: Set<LocalTypeDeclaration>;
}

const isPredicateMember = (sourceCode: SourceCode, expression: ESTree.Expression, name: string) => {
  const imported = importedMember(sourceCode, expression);
  return imported?.source === "effect/Predicate" && imported.name === name;
};

const isSchemaDeclare = (sourceCode: SourceCode, call: ESTree.CallExpression) => {
  const imported = importedMember(sourceCode, call.callee);
  return imported?.source === "effect/Schema" && imported.name === "declare";
};

const isGlobalFunction = (expression: ESTree.Expression) => {
  const value = unwrapExpression(expression);
  return value.type === "Identifier" && value.name === "Function";
};

/** `Function.prototype.isPrototypeOf(x)` */
const isFunctionPrototypeCheck = (callee: ESTree.Expression) => {
  const method = unwrapExpression(callee);
  if (method.type !== "MemberExpression") return false;
  if (staticPropertyName(method.property, method.computed) !== "isPrototypeOf") return false;
  const prototype = unwrapExpression(method.object);
  return (
    prototype.type === "MemberExpression" &&
    staticPropertyName(prototype.property, prototype.computed) === "prototype" &&
    isGlobalFunction(prototype.object)
  );
};

const typeofOperand = (expression: ESTree.Expression): ESTree.Expression | null => {
  const value = unwrapExpression(expression);
  return value.type === "UnaryExpression" && value.operator === "typeof" ? value.argument : null;
};

const isFunctionString = (expression: ESTree.Expression) => {
  const value = unwrapExpression(expression);
  return isStringLiteral(value) && value.value === "function";
};

/** Return the value whose callability `node` tests, if it is a callability check. */
const callabilitySubject = (
  sourceCode: SourceCode,
  node: ESTree.CallExpression | ESTree.BinaryExpression,
): ESTree.Expression | null => {
  if (node.type === "CallExpression") {
    const [argument] = node.arguments;
    if (argument === undefined || argument.type === "SpreadElement") return null;
    return isPredicateMember(sourceCode, node.callee, "isFunction") ||
      isFunctionPrototypeCheck(node.callee)
      ? argument
      : null;
  }
  if (node.operator === "instanceof") return isGlobalFunction(node.right) ? node.left : null;
  if (!["===", "==", "!==", "!="].includes(node.operator)) return null;
  if (isFunctionString(node.right)) return typeofOperand(node.left);
  return isFunctionString(node.left) ? typeofOperand(node.right) : null;
};

/** Resolve `subject.a.b` to `["a", "b"]`; other expressions have no path. */
const subjectPath = (expression: ESTree.Expression, subject: string): Path | null => {
  const value = unwrapExpression(expression);
  if (value.type === "Identifier") return value.name === subject ? [] : null;
  if (value.type !== "MemberExpression") return null;
  const name = staticPropertyName(value.property, value.computed);
  const parent = name === null ? null : subjectPath(value.object, subject);
  return parent === null || name === null ? null : [...parent, name];
};

const enclosingFunction = (node: ESTree.Node): RuntimeFunction | null => {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && !isRuntimeFunction(current)) current = current.parent;
  return current;
};

const enclosingTypeParameters = (node: ESTree.Node): ReadonlySet<string> => {
  const names = new Set<string>();
  for (let current: ESTree.Node | null = node; current !== null; current = current.parent) {
    if (
      isRuntimeFunction(current) ||
      current.type === "ClassDeclaration" ||
      current.type === "ClassExpression"
    )
      for (const parameter of current.typeParameters?.params ?? []) names.add(parameter.name.name);
  }
  return names;
};

const parameterNamed = (fn: RuntimeFunction, name: string) =>
  fn.params.find((parameter) => parameter.type === "Identifier" && parameter.name === name);

const typeParameterName = (type: ESTree.TSType | undefined): string | null =>
  type?.type === "TSTypeReference" &&
  type.typeName.type === "Identifier" &&
  type.typeArguments === null
    ? type.typeName.name
    : null;

const declaredInputType = (fn: RuntimeFunction, subject: string) => {
  const parameter = parameterNamed(fn, subject);
  return parameter?.type === "Identifier"
    ? typeParameterName(parameter.typeAnnotation?.typeAnnotation)
    : null;
};

/** The claim of a `value is T` predicate, or of an untyped `Schema.declare<T>` callback. */
const functionClaim = (sourceCode: SourceCode, fn: RuntimeFunction): Claim | null => {
  const predicate = fn.returnType?.typeAnnotation;
  if (predicate?.type === "TSTypePredicate") {
    if (predicate.asserts || predicate.parameterName.type !== "Identifier") return null;
    const type = predicate.typeAnnotation?.typeAnnotation;
    const subject = predicate.parameterName.name;
    return type === undefined
      ? null
      : {
          subject,
          type,
          report: predicate,
          inputType: declaredInputType(fn, subject),
          typeParameters: enclosingTypeParameters(fn),
        };
  }
  const call = fn.parent;
  const [first] = fn.params;
  const type = call.type === "CallExpression" ? call.typeArguments?.params[0] : undefined;
  if (
    call.type !== "CallExpression" ||
    call.arguments[0] !== fn ||
    type === undefined ||
    first?.type !== "Identifier" ||
    !isSchemaDeclare(sourceCode, call)
  )
    return null;
  return {
    subject: first.name,
    type,
    report: type,
    inputType: declaredInputType(fn, first.name),
    typeParameters: enclosingTypeParameters(fn),
  };
};

const memberName = (member: ESTree.TSSignature): string | null =>
  member.type === "TSPropertySignature" || member.type === "TSMethodSignature"
    ? staticPropertyName(member.key, member.computed)
    : null;

/**
 * Whether members claim a callable at `path`: `true` or `false` when the members decide it,
 * `null` when they do not declare the first path segment.
 */
const membersClaimCallable = (
  members: readonly ESTree.TSSignature[],
  path: Path,
  environment: TypeEnvironment,
): boolean | null => {
  const [head, ...rest] = path;
  if (head === undefined)
    return members.some(
      (member) =>
        member.type === "TSCallSignatureDeclaration" ||
        member.type === "TSConstructSignatureDeclaration",
    );
  const named = members.filter((member) => memberName(member) === head);
  const candidates =
    named.length > 0 ? named : members.filter((member) => member.type === "TSIndexSignature");
  if (candidates.length === 0) return null;
  return candidates.some((member) => {
    if (member.type === "TSMethodSignature") return true;
    const annotation =
      member.type === "TSPropertySignature" || member.type === "TSIndexSignature"
        ? member.typeAnnotation?.typeAnnotation
        : undefined;
    return annotation !== undefined && claimsCallable(annotation, rest, environment);
  });
};

const declarationClaimsCallable = (
  declaration: LocalTypeDeclaration,
  path: Path,
  environment: TypeEnvironment,
): boolean => {
  if (environment.seen.has(declaration)) return false;
  environment.seen.add(declaration);
  if (declaration.type === "TSTypeAliasDeclaration")
    return claimsCallable(declaration.typeAnnotation, path, environment);
  const declared = membersClaimCallable(declaration.body.body, path, environment);
  // A member inherited from an unseen base type could be callable.
  return declared ?? (path.length > 0 && declaration.extends.length > 0);
};

const referenceClaimsCallable = (
  type: ESTree.TSTypeReference,
  path: Path,
  environment: TypeEnvironment,
): boolean => {
  const name = typeParameterName(type);
  if (type.typeName.type !== "Identifier") return true;
  if (name === "Function" && !environment.claim.typeParameters.has(name)) return false;
  if (name === null || environment.claim.typeParameters.has(name)) return true;
  const declarations = environment.declarations(name);
  // Type parameters and imported types are opaque, so a callability check cannot verify them.
  return (
    declarations.length === 0 ||
    declarations.some((declaration) => declarationClaimsCallable(declaration, path, environment))
  );
};

// Types whose shape is not written here, so a callability check cannot verify them.
const opaqueTypes = new Set<ESTree.TSType["type"]>([
  "TSConditionalType",
  "TSImportType",
  "TSIndexedAccessType",
  "TSInferType",
  "TSTypeQuery",
]);

/** Whether `type` claims a callable value at `path` that a callability check cannot verify. */
function claimsCallable(type: ESTree.TSType, path: Path, environment: TypeEnvironment): boolean {
  if (type.type === "TSParenthesizedType")
    return claimsCallable(type.typeAnnotation, path, environment);
  if (type.type === "TSUnionType" || type.type === "TSIntersectionType")
    return type.types.some(
      (member) =>
        (environment.claim.inputType === null ||
          typeParameterName(member) !== environment.claim.inputType) &&
        claimsCallable(member, path, environment),
    );
  if (type.type === "TSFunctionType" || type.type === "TSConstructorType") return path.length === 0;
  if (type.type === "TSTypeLiteral")
    return membersClaimCallable(type.members, path, environment) ?? false;
  if (type.type === "TSTypeReference") return referenceClaimsCallable(type, path, environment);
  return opaqueTypes.has(type.type);
}

const topLevelDeclarations = (program: ESTree.Program) => {
  const declarations = new Map<string, LocalTypeDeclaration[]>();
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      declaration?.type !== "TSTypeAliasDeclaration" &&
      declaration?.type !== "TSInterfaceDeclaration"
    )
      continue;
    const named = declarations.get(declaration.id.name) ?? [];
    named.push(declaration);
    declarations.set(declaration.id.name, named);
  }
  return declarations;
};

export const noCallableTypePredicateRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type predicates that claim a callable type after checking only callability.",
    },
    messages: {
      callablePredicate:
        "A callability check cannot verify a callback's parameters or result. Admit foreign callbacks with `ForeignCallable` from pi-cosmic-core and decode the result.",
    },
  },
  createOnce(context) {
    let reported = new Set<ESTree.Node>();
    let declarations: ReadonlyMap<string, readonly LocalTypeDeclaration[]> | null = null;

    const localDeclarations = (name: string) => {
      declarations ??= topLevelDeclarations(context.sourceCode.ast);
      return declarations.get(name) ?? [];
    };

    const reportUnverified = (claim: Claim, path: Path) => {
      if (reported.has(claim.report)) return;
      const environment: TypeEnvironment = {
        claim,
        declarations: localDeclarations,
        seen: new Set(),
      };
      if (!claimsCallable(claim.type, path, environment)) return;
      reported.add(claim.report);
      context.report({ node: claim.report, messageId: "callablePredicate" });
    };

    const checkCallability = (node: ESTree.CallExpression | ESTree.BinaryExpression) => {
      const subject = callabilitySubject(context.sourceCode, node);
      const fn = subject === null ? null : enclosingFunction(node);
      const claim = fn === null ? null : functionClaim(context.sourceCode, fn);
      const path = claim === null || subject === null ? null : subjectPath(subject, claim.subject);
      if (claim !== null && path !== null) reportUnverified(claim, path);
    };

    return {
      before() {
        reported = new Set();
        declarations = null;
      },
      BinaryExpression: checkCallability,
      CallExpression(node) {
        checkCallability(node);
        // `Schema.declare<T>(Predicate.isFunction)` claims `T` with only a callability check.
        const [guard] = node.arguments;
        const type = node.typeArguments?.params[0];
        if (
          type === undefined ||
          guard === undefined ||
          guard.type === "SpreadElement" ||
          !isSchemaDeclare(context.sourceCode, node) ||
          !isPredicateMember(context.sourceCode, guard, "isFunction")
        )
          return;
        reportUnverified(
          {
            subject: "",
            type,
            report: type,
            inputType: null,
            typeParameters: enclosingTypeParameters(node),
          },
          [],
        );
      },
    };
  },
});
