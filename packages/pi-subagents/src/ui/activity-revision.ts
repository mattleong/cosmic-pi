import type { ActivityItem } from "pi-cosmic-ui/activity";
import { sha256Text } from "pi-cosmic-core";

/** An item before its revision is stamped; distributes over the status variants. */
type UnrevisionedItem<Item extends ActivityItem = ActivityItem> = Item extends ActivityItem
  ? Omit<Item, "revision">
  : never;

/**
 * Stamps a revision that changes only when this item's published fields or `identity` change, so
 * unrelated runs, workflows and log lines never void an action the user is confirming.
 */
export const withActivityRevision = (item: UnrevisionedItem, identity = ""): ActivityItem =>
  Object.freeze({
    ...item,
    revision: sha256Text(JSON.stringify([identity, item])).slice(0, 32),
  } satisfies ActivityItem);
