import type { SubagentBackend, SubagentModelView } from "./model.ts";

const MAX_DISCOVERY_RESULTS = 100;
const MAX_NEAR_MATCHES = 6;

/**
 * Claude CLI aliases advertised by discovery. Aliases track the installed CLI's current mapping;
 * an exact Claude version requires its full model ID and is never translated into an alias.
 */
export const CLAUDE_CLI_ALIAS_MODELS: ReadonlyArray<SubagentModelView> = [
  { backend: "claude-cli", id: "fable", name: "Claude Fable (CLI alias)", reasoning: true },
  { backend: "claude-cli", id: "sonnet", name: "Claude Sonnet (CLI alias)", reasoning: true },
  { backend: "claude-cli", id: "opus", name: "Claude Opus (CLI alias)", reasoning: true },
  { backend: "claude-cli", id: "haiku", name: "Claude Haiku (CLI alias)", reasoning: true },
];

export const CLAUDE_CLI_ALIASES: ReadonlySet<string> = new Set(
  CLAUDE_CLI_ALIAS_MODELS.map((model) => model.id),
);

export interface PiCatalogModel {
  readonly provider: string;
  readonly id: string;
}

export const canonicalPiModelId = (model: PiCatalogModel): string =>
  `${model.provider}/${model.id}`;

/** Model line in the exact `backend` and `model` values `subagent_start` accepts verbatim. */
export const launchReadyModelLine = (model: SubagentModelView): string =>
  `backend=${model.backend} model=${model.id} · ${model.name} · ${model.reasoning ? "reasoning" : "no reasoning"}`;

const searchRank = (model: SubagentModelView, terms: ReadonlyArray<string>): number => {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const joined = terms.join(" ");
  if (id === joined || name === joined) return 0;
  if (id.includes(joined) || name.includes(joined)) return 1;
  if (terms.every((term) => id.includes(term))) return 2;
  return 3;
};

/**
 * Discovery search: every whitespace-separated term must match (AND semantics), and results are
 * ordered by match closeness with the stable catalog order breaking ties.
 */
export const searchSubagentModels = (
  models: ReadonlyArray<SubagentModelView>,
  query: string | undefined,
  backend?: SubagentBackend | undefined,
): ReadonlyArray<SubagentModelView> => {
  const scoped =
    backend === undefined ? models : models.filter((model) => model.backend === backend);
  const terms = query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  if (terms.length === 0) return scoped.slice(0, MAX_DISCOVERY_RESULTS);
  return scoped
    .flatMap((model) => {
      const searchable = `${model.backend} ${model.id} ${model.name}`.toLowerCase();
      return terms.every((term) => searchable.includes(term))
        ? [{ model, rank: searchRank(model, terms) }]
        : [];
    })
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.model)
    .slice(0, MAX_DISCOVERY_RESULTS);
};

export type PiModelResolution =
  | { readonly kind: "resolved"; readonly provider: string; readonly id: string }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly kind: "unknown"; readonly nearMatches: ReadonlyArray<string> };

const nearMatchesFor = (
  selector: string,
  available: ReadonlyArray<PiCatalogModel>,
): ReadonlyArray<string> => {
  const lowered = selector.toLowerCase();
  const bare = lowered.includes("/") ? lowered.slice(lowered.lastIndexOf("/") + 1) : lowered;
  return available
    .map(canonicalPiModelId)
    .filter((canonical) => {
      const candidate = canonical.toLowerCase();
      return candidate.includes(lowered) || candidate.includes(bare) || bare.includes(candidate);
    })
    .sort()
    .slice(0, MAX_NEAR_MATCHES);
};

/**
 * Deterministic Pi model resolution against the authenticated catalog.
 *
 * Exact canonical `provider/model` values win; a bare model ID resolves only when it matches
 * exactly one provider. Ambiguity and unknown selectors return structured candidates instead of
 * arbitrarily selecting a provider.
 */
export const resolvePiModelSelector = (
  selector: string,
  available: ReadonlyArray<PiCatalogModel>,
): PiModelResolution => {
  const trimmed = selector.trim();
  const lowered = trimmed.toLowerCase();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const exact = available.filter((model) => canonicalPiModelId(model) === trimmed);
    const matched =
      exact.length > 0
        ? exact
        : available.filter((model) => canonicalPiModelId(model).toLowerCase() === lowered);
    if (matched.length === 1 && matched[0]) return { kind: "resolved", ...matched[0] };
    if (matched.length > 1)
      return { kind: "ambiguous", candidates: matched.map(canonicalPiModelId).sort() };
    return { kind: "unknown", nearMatches: nearMatchesFor(trimmed, available) };
  }
  const exact = available.filter((model) => model.id === trimmed);
  const matched =
    exact.length > 0 ? exact : available.filter((model) => model.id.toLowerCase() === lowered);
  if (matched.length === 1 && matched[0]) return { kind: "resolved", ...matched[0] };
  if (matched.length > 1)
    return { kind: "ambiguous", candidates: matched.map(canonicalPiModelId).sort() };
  return { kind: "unknown", nearMatches: nearMatchesFor(trimmed, available) };
};

export interface ClaudeCliModelConflict {
  readonly code: "backend_model_mismatch" | "claude_model_invalid";
  readonly message: string;
}

/**
 * Fast-fail detection of Pi selectors sent to claude-cli. Claude CLI models are aliases or full
 * Claude model IDs; canonical Pi `provider/model` values (and bare IDs that identify authenticated
 * Pi models) must launch through `backend: "pi"` instead of being reinterpreted.
 */
export const claudeCliModelConflict = (
  selector: string,
  availablePi: ReadonlyArray<PiCatalogModel>,
): ClaudeCliModelConflict | undefined => {
  const trimmed = selector.trim();
  if (trimmed.includes("/")) {
    const canonical = availablePi.filter(
      (model) => canonicalPiModelId(model).toLowerCase() === trimmed.toLowerCase(),
    );
    if (canonical.length > 0)
      return {
        code: "backend_model_mismatch",
        message: `"${trimmed}" is an authenticated Pi model; launch it with backend "pi". Claude CLI models are Claude aliases (fable, sonnet, opus, haiku) or full Claude model IDs.`,
      };
    return {
      code: "claude_model_invalid",
      message: `Claude CLI models never use provider/model form; "${trimmed}" is not launchable. Pass a Claude alias (fable, sonnet, opus, haiku) or a full Claude model ID.`,
    };
  }
  if (CLAUDE_CLI_ALIASES.has(trimmed) || trimmed.toLowerCase().startsWith("claude"))
    return undefined;
  const bareMatches = availablePi.filter((model) => model.id === trimmed);
  if (bareMatches.length === 0) return undefined;
  const candidates = bareMatches.map(canonicalPiModelId).sort();
  return {
    code: "backend_model_mismatch",
    message:
      candidates.length === 1
        ? `"${trimmed}" is an authenticated Pi model ID; launch it with backend "pi" and model "${candidates[0]}", or pass a Claude alias/full Claude model ID for claude-cli.`
        : `"${trimmed}" matches authenticated Pi models (${candidates.join(", ")}); launch it with backend "pi" using one canonical value, or pass a Claude alias/full Claude model ID for claude-cli.`,
  };
};
