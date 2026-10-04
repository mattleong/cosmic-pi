import type { ActivityRow } from "./model.ts";

type ActivityAction = NonNullable<ActivityRow["actions"]>[number];

/** Number keys reach any action; a page holds nine and `a` turns to the next. */
export const ACTIVITY_ACTION_PAGE_SIZE = 9;

/** Direct keys for common producer action ids, in the order each key prefers them. */
const ACTIVITY_ACTION_KEYS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["x", ["stop", "skip"]],
  ["i", ["interrupt"]],
  ["u", ["resume"]],
  ["m", ["reply", "message"]],
  ["e", ["rename"]],
  ["c", ["clear", "clear-finished"]],
];

/** The action a direct key invokes: the first one, in the key's preference order, offered. */
export const activityActionForKey = (
  actions: ReadonlyArray<ActivityAction>,
  key: string,
): ActivityAction | undefined =>
  ACTIVITY_ACTION_KEYS.find(([candidate]) => candidate === key)?.[1]
    .flatMap((id) => actions.filter((action) => action.id === id))
    .at(0);

/** The number of action pages a row needs. */
export const activityActionPages = (actions: ReadonlyArray<ActivityAction> | undefined): number =>
  Math.max(1, Math.ceil((actions?.length ?? 0) / ACTIVITY_ACTION_PAGE_SIZE));

export interface ActivityActionHints {
  /** What the default footer shows: a single direct key, then the number keys it leaves. */
  readonly primary: string | undefined;
  /** Every action key, for the full help. */
  readonly all: string | undefined;
  /** The bare keys, for the narrowest help. */
  readonly keys: ReadonlyArray<string>;
}

const join = (parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ") || undefined;

/**
 * Footer hints for a selected row's actions on the shown action page. A row with one direct-key
 * action shows that key, so the common stop or skip needs no help screen; number keys cover the
 * page's actions, and `a` appears only when there are more actions than one page holds.
 */
export function activityActionHints(
  row: ActivityRow | undefined,
  page: number,
): ActivityActionHints {
  const actions = row && !row.retained ? (row.actions ?? []) : [];
  const keyed = ACTIVITY_ACTION_KEYS.flatMap(([key]) => {
    const action = activityActionForKey(actions, key);
    return action ? [{ key, action }] : [];
  });
  const direct = join(keyed.map(({ key, action }) => `${key} ${action.label}`));
  const paged = actions.length > ACTIVITY_ACTION_PAGE_SIZE;
  const start =
    Math.min(Math.max(0, page), activityActionPages(actions) - 1) * ACTIVITY_ACTION_PAGE_SIZE;
  const shown = actions.slice(start, start + ACTIVITY_ACTION_PAGE_SIZE);
  const only = shown.length === 1 ? shown[0] : undefined;
  // One action with a direct key needs no number key beside it.
  const numberKeys =
    shown.length === 0 || (actions.length === 1 && keyed.length > 0)
      ? undefined
      : only
        ? "1"
        : `1-${shown.length}`;
  const numbered =
    numberKeys &&
    `${numberKeys} ${only ? only.label : "Actions"}${paged ? " · a More actions" : ""}`;
  return {
    primary: join([keyed.length === 1 ? direct : undefined, numbered]),
    all: join([direct, numbered]),
    keys: [
      ...keyed.map(({ key }) => key),
      ...(numberKeys ? [numberKeys] : []),
      ...(paged ? ["a"] : []),
    ],
  };
}
