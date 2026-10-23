import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { ActivityItem } from "pi-cosmic-ui/activity";
import { sha256Text } from "pi-cosmic-core/security/sha256";

type UnrevisionedItem<Item extends ActivityItem = ActivityItem> = Item extends ActivityItem
  ? Omit<Item, "revision">
  : never;

export const withActivityRevision = (item: UnrevisionedItem, identity = ""): ActivityItem =>
  Object.freeze({
    ...item,
    revision: Fn.pipe(sha256Text(JSON.stringify([identity, item])), Str.slice(0, 32)),
  } satisfies ActivityItem);
