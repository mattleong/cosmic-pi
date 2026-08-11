/**
 * Best-effort Pi notification boundary, owned by `pi-cosmic-core`.
 *
 * Promise-level Pi command recovery must never reject because notification failed.
 */
export { notifyAtHostBoundary, type HostNotificationLevel } from "pi-cosmic-core";
