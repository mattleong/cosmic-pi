import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { ActivityRow } from "./model.ts";

type ActivityAction = NonNullable<ActivityRow["actions"]>[number];

/** Actions without a letter key are numbered, nine to a page. */
export const ACTIVITY_ACTION_PAGE_SIZE = 9;

const ACTIVITY_ACTION_KEYS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["x", ["stop"]],
  ["i", ["interrupt"]],
  ["u", ["resume"]],
  ["m", ["reply", "message"]],
  ["e", ["rename"]],
  ["c", ["clear"]],
];

const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export const activityShortcuts: ReadonlySet<string> = new Set([
  "a",
  "r",
  "w",
  "z",
  "f",
  "t",
  ...Arr.map(ACTIVITY_ACTION_KEYS, ([key]) => key),
  ...NUMBER_KEYS,
]);

export interface KeyedActivityAction {
  readonly key: string;
  readonly action: ActivityAction;
}

export interface ActivityActionKeys {
  /** The actions offered on this page in their producer's order, each with its one key. */
  readonly shown: ReadonlyArray<KeyedActivityAction>;
  readonly lettered: ReadonlyArray<KeyedActivityAction>;
  readonly numbered: ReadonlyArray<KeyedActivityAction>;
  readonly page: number;
  readonly pages: number;
}

/**
 * Gives every action exactly one key: its letter when it has one, otherwise a digit on the
 * current page. The pane, the hint bar, and key handling all read this assignment.
 */
export const activityActionKeys = (
  actions: ReadonlyArray<ActivityAction> | undefined,
  page = 0,
): ActivityActionKeys => {
  const all = actions ?? [];
  const letters = new Map<ActivityAction, string>();
  for (const [key, ids] of ACTIVITY_ACTION_KEYS) {
    // Synonyms share a letter; the first offered one takes it and any other is numbered.
    const match = Arr.flatMap(ids, (id) => Arr.filter(all, (action) => action.id === id)).at(0);
    if (match) letters.set(match, key);
  }
  const unlettered = Arr.filter(all, (action) => !letters.has(action));
  const pages = Math.max(1, Math.ceil(unlettered.length / ACTIVITY_ACTION_PAGE_SIZE));
  const current = Math.min(Math.max(0, page), pages - 1);
  const pageActions = unlettered.slice(
    current * ACTIVITY_ACTION_PAGE_SIZE,
    (current + 1) * ACTIVITY_ACTION_PAGE_SIZE,
  );
  const numbers = new Map(
    Arr.map(pageActions, (action, index) => [action, NUMBER_KEYS[index] ?? ""] as const),
  );
  const shown = Arr.flatMap(all, (action): KeyedActivityAction[] => {
    const key = letters.get(action) ?? numbers.get(action);
    return key ? [{ key, action }] : [];
  });
  return {
    shown,
    lettered: Arr.filter(shown, ({ action }) => letters.has(action)),
    numbered: Arr.filter(shown, ({ action }) => numbers.has(action)),
    page: current,
    pages,
  };
};

export const activityActionPages = (actions: ReadonlyArray<ActivityAction> | undefined): number =>
  activityActionKeys(actions).pages;

export const activityActionForKey = (
  actions: ReadonlyArray<ActivityAction>,
  key: string,
  page = 0,
): ActivityAction | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(activityActionKeys(actions, page).shown, (keyed) => keyed.key === key),
  )?.action;

export interface ActivityActionHints {
  /** Every action key on this page, named as the pane lists them. */
  readonly primary: string | undefined;
}

const join = (parts: ReadonlyArray<string | undefined>) =>
  Arr.join(
    Arr.filter(parts, (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part)),
    " · ",
  ) || undefined;

export function activityActionHints(
  row: ActivityRow | undefined,
  page: number,
): ActivityActionHints {
  const keys = activityActionKeys(row && !row.retained ? row.actions : [], page);
  const only = keys.numbered.length === 1 ? keys.numbered[0] : undefined;
  const last = keys.numbered.at(-1);
  const numbered = only
    ? `${only.key} ${only.action.label}`
    : last
      ? `1-${last.key} Actions`
      : undefined;
  return {
    primary: join([
      ...Arr.map(keys.lettered, ({ key, action }) => `${key} ${action.label}`),
      numbered,
      keys.pages > 1 ? "a More actions" : undefined,
    ]),
  };
}
