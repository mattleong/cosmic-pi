import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import type { SubagentEffort } from "../domain/routing.ts";

const MAX_NEAR_MATCHES = 6;

export interface PiCatalogModel {
  readonly provider: string;
  readonly id: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
  readonly contextWindow?: number | undefined;
}

const canonicalPiModelId = (model: PiCatalogModel): string => `${model.provider}/${model.id}`;

// Registry context variants ("model@1m") name the same model with a different window.
const baseModel = (model: string): string => Str.toLowerCase(Str.split(model, "@")[0]);
export const samePiModel = (selected: string, required: string): boolean =>
  baseModel(selected) === baseModel(required);

type PiModelResolution =
  | { readonly kind: "resolved"; readonly provider: string; readonly id: string }
  | { readonly kind: "ambiguous"; readonly candidates: ReadonlyArray<string> }
  | { readonly kind: "unknown"; readonly nearMatches: ReadonlyArray<string> };

const nearMatchesFor = (
  selector: string,
  available: ReadonlyArray<PiCatalogModel>,
): ReadonlyArray<string> => {
  const lowered = Str.toLowerCase(selector);
  const bare = Option.match(Fn.pipe(lowered, Str.lastIndexOf("/")), {
    onNone: () => lowered,
    onSome: (slash) => Fn.pipe(lowered, Str.slice(slash + 1)),
  });
  return Arr.sort(
    Arr.flatMap(available, (model) => {
      const canonical = canonicalPiModelId(model);
      const candidate = Str.toLowerCase(canonical);
      return Fn.pipe(candidate, Str.includes(lowered)) ||
        Fn.pipe(candidate, Str.includes(bare)) ||
        Fn.pipe(bare, Str.includes(candidate))
        ? [canonical]
        : [];
    }),
    Order.String,
  ).slice(0, MAX_NEAR_MATCHES);
};

export const resolvePiModelSelector = (
  selector: string,
  available: ReadonlyArray<PiCatalogModel>,
): PiModelResolution => {
  const trimmed = Str.trim(selector);
  const lowered = Str.toLowerCase(trimmed);
  const comparisonKey = Option.exists(
    Fn.pipe(trimmed, Str.indexOf("/")),
    (slash) => slash > 0 && slash < trimmed.length - 1,
  )
    ? canonicalPiModelId
    : (model: PiCatalogModel) => model.id;
  const exact = Arr.filter(available, (model) => comparisonKey(model) === trimmed);
  const matched =
    exact.length > 0
      ? exact
      : Arr.filter(available, (model) => Str.toLowerCase(comparisonKey(model)) === lowered);
  if (matched.length === 1 && matched[0]) return { kind: "resolved", ...matched[0] };
  if (matched.length > 1)
    return {
      kind: "ambiguous",
      candidates: Arr.sort(Arr.map(matched, canonicalPiModelId), Order.String),
    };
  return { kind: "unknown", nearMatches: nearMatchesFor(trimmed, available) };
};
