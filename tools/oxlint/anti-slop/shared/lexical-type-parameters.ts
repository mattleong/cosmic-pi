import type { ESTree, SourceCode } from "@oxlint/plugins";

function collectInferTypeParameterNames(
	sourceCode: SourceCode,
	node: ESTree.Node,
	names: Set<string>,
): void {
	for (const token of sourceCode.getTokens(node)) {
		if (token.value !== "infer") continue;
		const inferred = sourceCode.getNodeByRangeIndex(token.start);
		if (inferred?.type === "TSInferType") names.add(inferred.typeParameter.name.name);
	}
}

export function lexicalTypeParameterNames(
	node: ESTree.Node,
	sourceCode: SourceCode,
): ReadonlySet<string> {
	const names = new Set<string>();
	let descendant: ESTree.Node = node;
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if ("typeParameters" in current) {
			for (const parameter of current.typeParameters?.params ?? []) {
				names.add(parameter.name.name);
			}
		}
		if (
			current.type === "TSMappedType" &&
			(descendant === current.nameType || descendant === current.typeAnnotation)
		) {
			names.add(current.key.name);
		}
		if (current.type === "TSConditionalType" && descendant === current.trueType) {
			collectInferTypeParameterNames(sourceCode, current.extendsType, names);
		}
		descendant = current;
		current = current.parent;
	}
	return names;
}
