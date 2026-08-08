// Synchronous, pure path arithmetic is confined to this explicit boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { dirname, join } from "node:path";

export const nodeDirname = dirname;
export const nodeJoin = join;
