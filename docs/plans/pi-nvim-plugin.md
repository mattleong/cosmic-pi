# Plan: `pi.nvim` (Neovim plugin, standalone repo)

Status: planning. Companion plan: [`pi-nvim-bridge.md`](pi-nvim-bridge.md) (the pi extension; canonical home of the wire protocol). User-perspective storyboard: [`pi-nvim-workflow.html`](pi-nvim-workflow.html). This plan lives in cosmic-pi until the `pi.nvim` repo exists.

## Goal

Send visually-selected code (with an optional annotation) or a bare `path:line-range` reference from Neovim into the pi session running for the same project — one keypress, no copy/paste, no transcribing file names.

## Decided (MVP)

- **Own repo** (`mattleong/pi.nvim`), installable with a plain lazy.nvim spec; during development, `{ dir = "~/dev/pi.nvim" }`.
- **Two verbs only:** send (snippet) and reference. Both deliver into pi's *input editor* (staging); queue-vs-steer decisions happen in pi, not here.
- **No LSP integration.** Plain commands + user-defined keymaps, in MVP and beyond. The public Lua API (`require("pi").send()`) is the only extension point anyone would need to wire it into other triggers themselves.
- **Connect-per-send**, no persistent socket, no external dependencies — pure `vim.uv`.
- Lua mirrors the wire contract defined in `pi-nvim-bridge`'s `PROTOCOL.md` / `protocol.ts` (`PROTOCOL_VERSION = 1`).

## Repo layout

```
pi.nvim/
  lua/pi/
    init.lua        # setup(opts), public API: send(), health()
    config.lua      # defaults + user overrides
    discovery.lua   # scan connection files, match, pick, cache
    client.lua      # vim.uv TCP: connect → one JSON line → read ack → close
    snippet.lua     # build payload from range/buffer state
  plugin/pi.lua     # :PiSend / :PiRef / :PiTarget command registration (eager, tiny)
  doc/pi.txt        # vimdoc mirror of the README (can land post-MVP)
  README.md         # install, keymap suggestions, protocol pointer
  LICENSE
```

## Public API

```lua
require("pi").setup({ ... })          -- optional; all keys have defaults

require("pi").send({
  kind = "snippet" | "reference",     -- default "snippet"
  line1 = 42, line2 = 67,             -- default: visual range or current line
  annotation = "…",                    -- optional; if nil and prompt=true, ask
  prompt = true,                       -- vim.ui.input for annotation
})
```

Commands are thin wrappers:

- `:'<,'>PiSend` — range command; prompts for an annotation (empty = none); sends snippet.
- `:'<,'>PiRef` — range command; prompts for annotation; sends reference (no code body).
- Both accept a normal-mode invocation (current line).
- `:PiTarget` / `:PiTarget!` — pick or clear the pinned target session for the current project (see Discovery).

No default keymaps (plugin-manager etiquette). README suggests:

```lua
vim.keymap.set({ "n", "x" }, "<leader>ps", function() require("pi").send() end)
vim.keymap.set({ "n", "x" }, "<leader>pr", function() require("pi").send({ kind = "reference" }) end)
```

## Payload construction (`snippet.lua`)

- Range: from the command range / visual marks, expanded to whole lines (linewise); 1-indexed inclusive — matches the protocol and pi's Read-tool addressing.
- `path`: `vim.api.nvim_buf_get_name(0)` — absolute; the extension relativizes. Unnamed buffers → error notify ("buffer has no file name").
- `text`: `nvim_buf_get_lines` joined — buffer content, not disk content.
- `language`: `vim.bo.filetype` (authoritative — covers shebangs, scratch filetypes).
- `modified`: `vim.bo.modified`.
- Size guard: if the snippet exceeds the protocol's 512 KB line budget (with JSON-escaping headroom), refuse with "selection too large — send a reference instead (:PiRef)".

## Discovery & session matching (`discovery.lua`)

Designed for two real topologies, with no dependency on any terminal multiplexer (Herdr, tmux, or none — all identical): **several repos each with a pi** (cwd ancestry resolves it automatically, no prompt) and **several pi instances on one repo** (one-time picker, pinned per project). Plus the worktree case: buffer in one checkout, pi in another, where no cwd matches at all.

1. Read `<agent_dir>/nvim-bridge-v1/*.json` (`agent_dir` default per `PROTOCOL.md`; config override `discovery_dir`). Ignore unreadable/undecodable files. Never delete anything — the extension owns cleanup.
2. Filter to candidates whose `cwd` is an ancestor of (or equals) the buffer's file path; fall back to nvim's cwd for unnamed-adjacent cases. Rank by longest matching `cwd` (nested checkouts). Environment inference (pane adjacency etc.) is deliberately not used — ambiguity is resolved by the user once, not guessed.
3. Exactly one candidate → use it silently. Several (multiple pis on the same repo) → `vim.ui.select` with label `sessionName  ·  <shortened cwd>`; the pinned choice makes this a first-send-only prompt.
4. **Zero cwd matches → picker over all live sessions** (each labeled with its cwd) rather than a hard error — this is the cross-worktree send, which is intentional often enough that dead-ending on it is wrong. Notify only when no sessions exist at all.
5. **Target cache is keyed per project** (the matched candidate `cwd`, or the buffer's project root for the zero-match fallback), not global — a multi-repo nvim switching buffers must not misroute. Any connection failure or `ok:false` ack drops that project's cached choice and re-scans on the next send. No PID-liveness checking client-side — a dead process refuses the connect, which is the same signal cheaper.
6. **Explicit targeting:** `:PiTarget` re-opens the picker over all live sessions and pins the choice for the current project; `:PiTarget!` clears it. Switching which pi receives snippets is a deliberate act, not only a failure recovery.

## Client (`client.lua`)

- `vim.uv.new_tcp()` → connect `127.0.0.1:<port>` → write one JSON line `{ protocolVersion, token, payload }` → await one ack line (2 s timeout) → close. Fully async; results surface via `vim.notify` (wrapped in `vim.schedule`).
- JSON via `vim.json.encode`/`decode`.

### Failure copy (explicit, no silent no-ops)

| Condition | Notify |
|---|---|
| No live pi sessions at all | `pi.nvim: no pi session running` |
| No cwd match (worktree case) | no error — picker over all live sessions |
| Connect refused / timeout | `pi.nvim: pi session unreachable — is it still running?` (drop cache, re-scan once, then give up with the first message) |
| Ack `protocol_mismatch` | `pi.nvim: protocol mismatch — update pi.nvim or pi-nvim-bridge` |
| Ack `auth_failed` | `pi.nvim: stale connection info — retrying` (drop cache, one retry) |
| Ack `no_ui` | `pi.nvim: target pi session has no interactive UI` |
| Ack `invalid_payload` / `internal` | `pi.nvim: send rejected (<reason>)` |
| Success | `→ pi: src/foo.ts:42-67` (info level; configurable off) |

## Config surface (`config.lua` defaults)

```lua
{
  discovery_dir = nil,        -- nil = protocol default under pi's agent dir
  prompt_annotation = true,   -- ask via vim.ui.input on send
  notify_on_success = true,
  ack_timeout_ms = 2000,
}
```

Deliberately small; no keymaps, no UI framework, no per-filetype behavior.

## Testing

- Pure functions (range expansion, payload building, candidate ranking) extracted so they're testable with plain busted/plenary — but MVP may ship with a manual checklist instead of a harness; keep the seams regardless.
- `:checkhealth pi` (`health()`): reports discovery dir existence, candidate sessions found, and protocol version — doubles as the debugging tool for "why won't it connect".
- Manual matrix: visual send, normal-line send, reference, annotation empty/non-empty, modified buffer badge, two pi sessions on one repo (picker → pin → subsequent sends silent), two repos routing automatically as buffers switch, worktree buffer with pi elsewhere (zero-match → all-sessions picker), `:PiTarget` re-pick and `:PiTarget!` clear, pi restarted (cache invalidation), pi absent.

## Distribution & platform

- Versioned by git tags; README states which `pi-nvim-bridge` protocol version each release speaks (exact-match handshake, so the pairing must be visible to users).
- macOS/Linux only, matching the bridge.

## Implementation order

1. Wait for/pin `pi-nvim-bridge`'s `protocol.ts` + `PROTOCOL.md` (agent-dir path especially).
2. `snippet.lua` + `discovery.lua` pure logic (range expansion, payload build, candidate ranking) — testable without pi.
3. `client.lua` against a live `pi -e` session with the bridge loaded.
4. Commands, config, failure copy, `:checkhealth pi`.
5. README (lazy spec, keymap suggestions, protocol pairing note), then push the repo.

**MVP acceptance:** the manual matrix in Testing passes end-to-end against a real pi session; every row of the failure-copy table is reachable and shows its message; `:checkhealth pi` correctly diagnoses "no discovery dir", "no candidates", and "healthy" states.

## Non-goals (v2+)

- Diagnostics send (`vim.diagnostic.get` for the range shipped as a new payload kind — first candidate once the protocol bumps; built-in API, no LSP plumbing).
- Enclosing-symbol send (treesitter normal-mode grab of the containing function).
- Receiving from pi (open location, apply patch) — would add an nvim-side listener; discovery schema already tolerates additive fields.
- Multi-snippet tray UI — stacking pastes in pi's input already covers batching.
- Worktree-aware matching (resolve the git common dir so worktrees of one repo match the same sessions automatically) — the upgrade path if the zero-match picker turns out to be a frequent stop rather than an edge case; purely client-side, no protocol change.

## Expected tuning after real use

Predictions worth checking after a week of dogfooding, so they're recognized as tuning rather than bugs:

- `prompt_annotation = true` may prove to be friction — the likely drift is flipping it off and typing context in pi instead (stage-only delivery makes that natural). Both paths are supported; the default follows usage.
- If composing around several large pastes in pi's input editor feels cramped, the escape hatch is transcript-side rendering — planned as v2 in the bridge, additive, no plugin changes.
- If the worktree fallback picker appears often, promote the git common-dir matcher from Non-goals.

## Open questions

- Confirm the default agent-dir path against `pi-nvim-bridge`'s `PROTOCOL.md` once pinned there (single source of truth; this plugin hardcodes the default + offers `discovery_dir` override).
- Whether `:PiSend` in normal mode should default to current line or current paragraph — start with current line; revisit after real use.
