# Plan: `pi-nvim-bridge` (pi extension)

Status: planning. Companion plan: [`pi-nvim-plugin.md`](pi-nvim-plugin.md) (the `pi.nvim` Neovim plugin, which will live in its own repo). User-perspective storyboard: [`pi-nvim-workflow.html`](pi-nvim-workflow.html).

## Goal

Let a Neovim instance send annotated code snippets and file references into a running interactive pi session without copy/paste. The extension is the receiving side: it listens on loopback, authenticates the sender, formats the payload, and stages it into pi's input editor.

## Decided (MVP)

- **Stage-only delivery.** Every accepted payload is formatted to text and delivered via `ctx.ui.pasteToEditor(text)`. Nothing is submitted, queued, or steered by the extension — the user finishes composing in pi and uses pi's native submit/steer/follow-up behavior. Consequences:
  - No `sendMessage` path, no `deliverAs` handling, no custom message renderer, no `pi-code-previews` dependency.
  - Successive sends stack in the editor (verified: `pasteToEditor` is implemented in interactive mode as a bracketed paste through `editor.handleInput`, so it inserts at the cursor and triggers pi's large-paste collapse).
  - Headless/RPC sessions are rejected: gate on `ctx.hasUI`, ack with `ok: false` so the client can surface it.
- **Two payload kinds:** `snippet` (code + optional annotation) and `reference` (`path:start-end` only, no code — for large regions pi should read itself).
- **Connect-per-send, single request/response per connection.** No persistent connections, no reconnect logic; staleness is self-healing.
- **Package name `pi-nvim-bridge`**, discovery namespace `nvim-bridge-v1`.
- Plugin lives in a separate repo (`pi.nvim`); this package is the canonical home of the wire contract.

## Protocol (canonical here; mirrored in Lua by `pi.nvim`)

Documented for humans in `PROTOCOL.md` in the package root; enforced at runtime by Effect `Schema` in `src/protocol.ts`. `PROTOCOL_VERSION = 1`.

The whole round trip:

```text
pi (extension)                                nvim (pi.nvim)
──────────────                                ──────────────
session_start:
  listen 127.0.0.1:<port>
  write <agentDir>/nvim-bridge-v1/<pid>.json
                                              user hits send:
                                              read *.json, match cwd / pinned target
                                              connect 127.0.0.1:<port>
                                              → {protocolVersion, token, payload}\n
  version check → auth → decode → hasUI
  format → ui.pasteToEditor(text)
  ← {ok:true}\n, close
                                              vim.notify("→ pi: src/foo.ts:42-67")
session_shutdown: close, delete <pid>.json
```

### Discovery

One file per pi process: `<agentDir>/nvim-bridge-v1/<pid>.json`, mode 0600, written atomically (via `pi-cosmic-core` `JsonDocumentStore` or equivalent):

```jsonc
{
  "protocolVersion": 1,
  "pid": 12345,
  "port": 49152,            // ephemeral, bound to 127.0.0.1 only
  "token": "<64 hex chars>",
  "sessionId": "…",
  "sessionName": "…",       // pi's session name; the human-readable handle in nvim's picker
  "cwd": "/abs/path"
}
```

- Keyed by **PID, not sessionId**: pi can switch/fork sessions in-process (`switchSession`, `/new`) while the listener survives. Contents (`sessionId`, `sessionName`, `cwd`) are refreshed on every `session_start` — and on rename if 0.84 exposes a usable hook (`session_info_changed`; confirm during implementation). `sessionName` exists so nvim can present a meaningful choice when several pi instances share one cwd; a stale name degrades the picker label, nothing else.
- Deleted on `session_shutdown`. On startup, the extension sweeps `nvim-bridge-v1/` and removes entries whose PID is no longer alive (same liveness approach as `pi-subagents` `writer-lease.ts`). The nvim side never deletes files — read-only consumer.

### Wire format

Newline-delimited JSON over TCP on `127.0.0.1`. Bounds and auth mirror `pi-subagents/src/boundary/supervisor-channel.ts`:

- Max line size 512 KB (bounded line parser — reuse/adapt `bounded-line-parser.ts` pattern).
- Small connection cap (4) and a 5 s deadline for the request after connect.
- Token compared with `crypto.timingSafeEqual`.

Request (one line, then the client half-closes or waits for ack):

```jsonc
{
  "protocolVersion": 1,
  "token": "…",
  "payload": {
    "kind": "snippet",           // or "reference"
    "path": "/abs/path/to/file", // absolute; extension relativizes
    "startLine": 42,             // 1-indexed, inclusive
    "endLine": 67,
    "text": "…",                 // required for snippet, absent for reference
    "language": "typescript",    // nvim filetype (authoritative over extension-guessing)
    "annotation": "why does this leak?",  // optional
    "modified": true             // buffer has unsaved changes
  }
}
```

Response (one line, then the server closes):

```jsonc
{ "ok": true }
{ "ok": false, "reason": "protocol_mismatch" | "auth_failed" | "no_ui" | "invalid_payload" | "internal" }
```

`protocol_mismatch` is checked before auth so an outdated `pi.nvim` gets an actionable error. Reasons are machine-readable enums; the client owns the human copy.

## Formatting (payload → pasted text)

- Path relativized against `ctx.cwd`; paths outside the cwd stay absolute (no `../../..` chains).
- Layout — annotation first (it reads as the prompt being built), then the reference line, then the code:

  ````text
  why does this leak the socket?

  src/boundary/host-listener.ts:42-67 (unsaved changes)
  ```typescript
  …
  ```
  ````

- `(unsaved changes)` badge only when `modified` is true.
- Fence length = max(3, longest backtick run in `text` + 1) so snippets containing fences don't break.
- `reference` kind pastes only the annotation (if any) and the `path:start-end` line — no fence.
- Trailing newline after the block so consecutive pastes don't fuse.

## Package structure

Follow the `pi-directory-models` skeleton and `scripts/check-package-layout.mjs` rules exactly:

```
packages/pi-nvim-bridge/
  index.ts                      # export { default } from "./src/extension.ts"
  package.json                  # "pi": { "extensions": ["./index.ts"] }, exports TS source, catalog deps
  tsconfig.json                 # extends ../../tsconfig.effect.json, NodeNext
  PROTOCOL.md                   # human-readable wire contract (canonical)
  ARCHITECTURE.md               # with Source map section
  README.md / LICENSE
  src/
    extension.ts                # factory: register session_start/session_shutdown callbacks only
    application.ts              # orchestration: lifecycle, format, paste; Effect services
    layer.ts                    # runtime wiring (makePiSessionRuntimeSlot / makePiManagedRuntime)
    protocol.ts                 # PROTOCOL_VERSION, Schemas for discovery file, request, ack
    boundary/
      host-listener.ts          # node:net server, token auth, framing  ← new net boundary
      host-discovery.ts         # discovery file write/refresh/sweep (fs)
      host-session.ts           # capture ctx.cwd, sessionId, sessionName, pid
  tests/                        # *.test.ts (vitest / @effect/vitest)
```

- Extension factory acquires nothing; the managed runtime starts on `session_start` and disposes on `session_shutdown` (per the `pi-directory-models` idiom).
- Formatting, path relativization, discovery-record building, and request validation are pure application code — the boundary files stay thin.
- **Required doc updates when implementing:** register `host-listener.ts` as a new `node:net` boundary in `docs/architecture/pi-boundaries.md`; add the package to root `AGENTS.md` and `README.md`.

## Lifecycle summary

1. `session_start` → start runtime (once per process), bind listener on `127.0.0.1:0`, generate token, sweep stale discovery files, write/refresh `<pid>.json`.
2. Connection → read one bounded line → version check → `timingSafeEqual` token check → Schema-decode payload → `ctx.hasUI` gate → format → `ctx.ui.pasteToEditor` → ack → close.
3. Later `session_start` (switch/fork/new) → refresh discovery file contents only.
4. `session_shutdown` → close listener, delete discovery file, dispose runtime.

## UX stance in pi's UI

The extension is silent in pi's own UI: the paste appearing in the editor **is** the success feedback, and failed requests (bad token, version mismatch, malformed payload) are reported only to the client via the ack — never as pi-side notifications. A misbehaving or hostile peer must not be able to spam the pi session; the user asks the nvim side when something didn't arrive.

## Distribution & platform

- Published to npm like the other public packages (`pi install npm:pi-nvim-bridge`); standard `prepublishOnly` / `pack:dry` scripts from the skeleton.
- Protocol compatibility is by exact `PROTOCOL_VERSION` match; a version bump here requires a coordinated `pi.nvim` release. Note the pairing in both READMEs.
- macOS/Linux only (POSIX file modes, agent-dir path convention). Windows explicitly out of scope.

## Testing

- Pure: formatter (fence escalation, badge, reference layout, trailing newline), path relativization (inside/outside cwd), Schema round-trips, discovery-record refresh logic.
- Boundary: exercise the real TCP server in vitest (connect via `node:net`) for auth failure, version mismatch, oversized line, happy path with a stubbed `pasteToEditor` capturing output.
- Manual: nvim + pi in adjacent terminal panes (any multiplexer or none), full round trip.

## Implementation order

1. `protocol.ts` (schemas + `PROTOCOL_VERSION`) and `PROTOCOL.md`, including the pinned agent-dir path — this unblocks the `pi.nvim` repo.
2. Pure application code with tests: formatter, path relativization, discovery-record building.
3. Boundaries: `host-listener.ts` (net), `host-discovery.ts` (fs), `host-session.ts`; lifecycle wiring via the cosmic-core runtime slot.
4. Boundary tests (real TCP against stubbed `pasteToEditor`), then manual round trip once `pi.nvim` exists.
5. Docs: `pi-boundaries.md` entry, `AGENTS.md`, root `README.md`, `ARCHITECTURE.md`.

**MVP acceptance:** from nvim, a visual-selection send and a reference land in the input editor of the correct pi session (two sessions running, cwd-disambiguated); stacked sends accumulate; unsaved-buffer badge renders; bad token, stale discovery file, version mismatch, and headless target each produce the documented client-side message and nothing in pi's UI; `pnpm validate` and layout checks pass.

## Non-goals (v2+)

- Transcript-side rendering (`sendMessage` + custom renderer + `pi-code-previews` card) — the designated escape hatch if composing around large pastes in the input editor proves cramped in practice; live with the paste version first.
- Diagnostics payload kind (schema is open to new `kind` values behind a version bump).
- Bidirectional flow (pi → nvim: open location, apply patch). Discovery schema tolerates additive fields (e.g. a future `nvimPort`).
- Steer/interrupt delivery modes; any queueing the input editor doesn't already provide.
- Non-loopback or remote scenarios.

## Open questions

- Exact `getAgentDir()` value in `@earendil-works/pi-coding-agent@0.84` — confirm the import and the resulting path during implementation; the path is part of the published contract in `PROTOCOL.md` (the nvim side hardcodes it with a config override).
- Whether `pi-cosmic-core` already exposes an atomic-write/JSON-store helper suitable for the discovery file, or a small host adapter is needed.
