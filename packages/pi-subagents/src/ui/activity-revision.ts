import type { ActivityItem } from "pi-cosmic-ui/activity";
import { sha256Text } from "pi-cosmic-core";

type UnrevisionedItem<Item extends ActivityItem = ActivityItem> = Item extends ActivityItem
  ? Omit<Item, "revision">
  : never;

export const withActivityRevision = (item: UnrevisionedItem, identity = ""): ActivityItem =>
  Object.freeze({
    ...item,
    revision: sha256Text(JSON.stringify([identity, item])).slice(0, 32),
  } satisfies ActivityItem);
