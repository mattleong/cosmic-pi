import type { ActivityRow } from "./model.ts";

type ActivityAction = NonNullable<ActivityRow["actions"]>[number];

export const ACTIVITY_ACTION_PAGE_SIZE = 9;

const ACTIVITY_ACTION_KEYS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["x", ["stop", "skip"]],
  ["i", ["interrupt"]],
  ["u", ["resume"]],
  ["m", ["reply", "message"]],
  ["e", ["rename"]],
  ["c", ["clear"]],
];

export const activityShortcuts: ReadonlySet<string> = new Set([
  "a",
  "r",
  "w",
  "z",
  "f",
  "t",
  ...ACTIVITY_ACTION_KEYS.map(([key]) => key),
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
]);

export const activityActionForKey = (
  actions: ReadonlyArray<ActivityAction>,
  key: string,
): ActivityAction | undefined =>
  ACTIVITY_ACTION_KEYS.find(([candidate]) => candidate === key)?.[1]
    .flatMap((id) => actions.filter((action) => action.id === id))
    .at(0);

export const activityActionPages = (actions: ReadonlyArray<ActivityAction> | undefined): number =>
  Math.max(1, Math.ceil((actions?.length ?? 0) / ACTIVITY_ACTION_PAGE_SIZE));

export interface ActivityActionHints {
  readonly primary: string | undefined;
  readonly all: string | undefined;
  readonly keys: ReadonlyArray<string>;
}

const join = (parts: ReadonlyArray<string | undefined>) =>
  parts.filter((part): part is string => Boolean(part)).join(" · ") || undefined;

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
