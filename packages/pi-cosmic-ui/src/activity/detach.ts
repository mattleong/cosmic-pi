import type { ActivityItem } from "./protocol.ts";

/** Copies an item and cleans every display field; producer and host ingress supply their own cleaners. */
export const detachActivityItem = (
  item: ActivityItem,
  text: (value: string, limit: number) => string,
  detail: (value: string) => string,
): ActivityItem => {
  const detached = { ...item, title: text(item.title, 512) };
  if (item.parent) Object.assign(detached, { parent: { ...item.parent } });
  if (item.profile !== undefined) Object.assign(detached, { profile: text(item.profile, 80) });
  if (item.route !== undefined) Object.assign(detached, { route: text(item.route, 512) });
  if (item.summary !== undefined) Object.assign(detached, { summary: text(item.summary, 4096) });
  if (item.detail !== undefined) Object.assign(detached, { detail: detail(item.detail) });
  if (item.actions)
    Object.assign(detached, {
      actions: item.actions.map((action) => {
        const value = { ...action, label: text(action.label, 4096) };
        if (action.confirmation !== undefined)
          Object.assign(value, { confirmation: text(action.confirmation, 4096) });
        return value;
      }),
    });
  return detached;
};
