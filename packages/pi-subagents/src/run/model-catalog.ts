import type { SubagentEffort } from "../domain/routing.ts";

const MAX_NEAR_MATCHES = 6;

export interface PiCatalogModel {
  readonly provider: string;
  readonly id: string;
  /** Authenticated host-reported effort capability when the host provides one. */
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
}

const canonicalPiModelId = (model: PiCatalogModel): string => `${model.provider}/${model.id}`;

type PiModelResolution =
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
 * Deterministic Pi model resolution for configured profile candidates.
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
  const comparisonKey =
    slash > 0 && slash < trimmed.length - 1
      ? canonicalPiModelId
      : (model: PiCatalogModel) => model.id;
  const exact = available.filter((model) => comparisonKey(model) === trimmed);
  const matched =
    exact.length > 0
      ? exact
      : available.filter((model) => comparisonKey(model).toLowerCase() === lowered);
  if (matched.length === 1 && matched[0]) return { kind: "resolved", ...matched[0] };
  if (matched.length > 1)
    return { kind: "ambiguous", candidates: matched.map(canonicalPiModelId).sort() };
  return { kind: "unknown", nearMatches: nearMatchesFor(trimmed, available) };
};
