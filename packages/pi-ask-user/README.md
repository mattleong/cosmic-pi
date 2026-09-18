# pi-ask-user

Structured, responsive questionnaires for [pi](https://github.com/earendil-works/pi-mono). The `ask_user` agent tool batches one to four decisions into one blocking dialog. In the TUI, `ask_user_async` opens the same dialog while the agent continues independent work.

## Install

```bash
pi install npm:pi-ask-user
```

Restart pi after installation. If another questionnaire extension is installed, disable it so the model sees only one ask-user tool.

## What it does

- Single- and multi-select questions with stable returned values.
- Required free-text questions when there are no meaningful alternatives.
- An automatic custom-answer action for every choice question.
- Optional notes that do not change the selected answer.
- Markdown previews beside choices on wide terminals and stacked below them on narrow terminals.
- A review step before answers are submitted.
- RPC fallback through Pi's native `select` and `input` dialogs.
- No local questionnaire tool in ordinary JSON or print modes. Marked local and Herdr Pi children use a root relay instead.

The extension never makes model calls and does not persist answers outside Pi's ordinary session history.

## Tool contract

The tool is named `ask_user`:

````json
{
  "questions": [
    {
      "key": "library",
      "title": "Library",
      "prompt": "Which date library should we use?",
      "mode": "single",
      "choices": [
        {
          "value": "date-fns",
          "label": "date-fns",
          "description": "Small functional helpers with tree-shakable imports."
        },
        {
          "value": "luxon",
          "label": "Luxon",
          "description": "Richer date-time objects and timezone support.",
          "preview": "```ts\nDateTime.now().setZone(zone)\n```"
        }
      ]
    }
  ]
}
````

Limits are intentionally bounded: 1-4 questions and 2-4 choices per single/multiple question. Question keys and choice values must be unique in their scope.

For a required free-text answer, use `mode: "text"` and omit `choices`:

```json
{
  "questions": [
    {
      "key": "details",
      "title": "Details",
      "prompt": "What requirement is missing?",
      "mode": "text"
    }
  ]
}
```

Text answers return `{ "key": "details", "kind": "text", "text": "The supplied wording" }`, with an optional `note`. Choice results keep `kind: "choices"`; their custom answers keep `kind: "custom"`. Text and custom answers are trimmed, must be nonblank, and allow at most 4,000 JavaScript code units. Notes are trimmed and allow at most 2,000 code units. Invalid input is rejected for editing, never truncated. Text questions cannot include choices, defaults, placeholders, or configurable limits.

Never use questionnaires to collect passwords, API keys, tokens, private keys, or other credentials.

Submitted results contain stable values and user-facing labels:

```json
{
  "outcome": "submitted",
  "answers": [
    {
      "key": "library",
      "kind": "choices",
      "values": ["luxon"],
      "labels": ["Luxon"],
      "note": "Timezone behavior matters most."
    }
  ]
}
```

Cancellation returns `{ "outcome": "cancelled", "answers": [] }`; unsubmitted drafts are discarded.

## Async questionnaires

`ask_user_async` accepts the same `questions` array plus two required, nonblank descriptions, each limited to 500 characters:

- `independentWork`: useful work the agent can do without the answers.
- `blockedWork`: decisions or work that must wait for the answers.

With no earlier questionnaire, the tool opens and focuses the overlay and returns a pending `requestId` and stable `deliveryId` once it is mounted. Otherwise it returns `presentation: queued` immediately. The queued overlay opens automatically when earlier questionnaires and unrelated prompts close. Neither receipt is an answer, and queued admission does not acknowledge mounting. The agent should then do only the declared independent work. Use blocking `ask_user` when no such work exists.

`ask_user_async_control` supports:

```json
{ "action": "status" }
{ "action": "status", "requestId": "<returned ID>" }
{ "action": "await", "requestId": "<returned ID>" }
{ "action": "cancel", "requestId": "<returned ID>" }
```

`status` without an ID lists retained metadata; with an ID it returns the full result. It never consumes an answer. Use `await` when independent work is exhausted, not repeated status polling. Only one caller can own answer delivery at a time. Cancel still closes the questionnaire when another caller is awaiting it. Interrupting an await leaves the questionnaire open and restores automatic answer delivery. Interrupting the opening tool after admission also leaves the session-owned request alive; `status` can recover its ID.

Submission and user cancellation normally arrive as a custom answer message using Pi's `steer` delivery with `triggerTurn: true`. While the agent is busy, Pi delivers it after the current tool batch; while idle, it starts a turn. An active await or cancel caller receives the result instead, without an additional automatic message. Cancellation is not approval and includes no drafts.

Results remain available for recovery. The registry holds at most 16 requests. New admission evicts only delivered terminal results without an active waiter; failed or undelivered results stay retained. When no result is eligible for eviction, admission rejects instead. Delivery IDs stay unchanged across status and await results. `sent` means the public host call returned, not that the model acknowledged the answer. Pi's public sender returns `void`, so later host delivery failures cannot be detected here. A synchronous delivery failure is marked `failed` and retried at most twice, one second apart. Await recovery suppresses pending retries, and runtime shutdown cancels them. Either kind of failure can be recovered through status or await. Repeated delivery IDs refer to the same answer, not a new decision.

Blocking, async, routed child questionnaires, and local-extension forms share a FIFO queue of at most 16 pending requests. Only one questionnaire is presented at a time. This limit is separate from the 16 retained async results. Cancelling a queued request settles its caller promptly, but its queue slot remains occupied until earlier requests close, preventing cancellation churn from growing background cleanup work. Full queues reject admission. Async admission still rejects unrelated public UI prompts; already queued requests wait for safe mounting.

Shutdown, reload, session replacement, and tree navigation close the questionnaire and revoke its IDs. Nothing is restored as pending work. A small versioned delivery receipt is recorded in Pi's session history immediately before sending an answer. Historical answers with a receipt on the active branch remain conversation history. Stale queued messages without that branch evidence stay filtered from model context, including after further navigation or reload. Other extensions' queues are untouched.

Async tools are TUI-only. RPC keeps the existing blocking `ask_user` behavior. The same hide/resume controls work in both TUI variants, without replacing or overwriting the main editor. Pi still counts a hidden custom dialog as an open UI prompt for status reporting.

## Activity view and child questions

Cosmic UI lists queued, open, hidden, and settled questionnaires in its unified activity view. You can resume a hidden questionnaire or confirm cancellation there. The overlay still opens automatically, so you never need to open the activity manager to answer. Hiding and resuming preserve drafts and the main editor. `/ask-user` remains available without Cosmic UI.

Explicit blocking `ask_user` calls from local and Herdr Pi subagents route to the root UI. The root coordinator supplies authenticated run ownership, so those questions appear beneath the owning agent. Standalone questions stay at the root. Answers return to the requesting child, never as root automatic answer messages. Run cancellation or session replacement cancels waiting or mounted requests. If a required child relay disappears, the tool fails instead of opening a child-local RPC dialog. Native Claude/Codex prompts and ordinary `contact_parent` questions are not redirected.

## Private forms for local extensions

`pi-ask-user/protocol` also exports a versioned `OwnedFormCapability`. This is a local-extension API, not an agent tool or subagent relay. A current TUI or RPC session publishes it; headless sessions and marked relay children do not. The caller supplies an `ExtensionFormOwner` with `extensionId`, `operationId`, `requestId`, and a user-facing `label`. These identities do not authenticate a subagent or grant permission to execute anything.

Forms use the same FIFO, public-prompt gate, TUI hide/resume controls, Activity view, and abort cleanup as questionnaires. At most 16 form calls can be live. Duplicate active owner identities are rejected. Exact-owner cancellation waits for the owned presentation cleanup. Answers return only to the calling extension, never through automatic steering, model-visible status, or session-history persistence by Ask User.

A form accepts 0 to 16 flat fields: string, finite number, integer, boolean, string enum, or an array of string-enum choices. Supported checks cover required values, defaults, numeric bounds, text lengths, selection counts, and `email`, `uri`, `date`, or `date-time` formats. These are bounded local checks, not a remote JSON Schema engine. Each enum field has at most 64 choices. MCP's separate schema mapper is stricter, allowing only 64 enum choices total across a form. Messages and string values are limited to 4,096 code units, URLs to 8,192, and each captured request or answer to 64 KiB of serialized UTF-8 JSON. Decoding also bounds depth and node count.

URL requests show the full inert URL and a prominent host for user consent. Accept means consent to browser navigation, not completed navigation. Ask User never opens or fetches a URL. The calling extension must check its current authority before any later browser action. For MCP, that responsibility belongs to `pi-mcp`, which owns system-browser navigation and asks for manual resume afterward. Request continuation state and form answers stay private to its operation. MCP's one-second cancellation wait is a consumer bound, not an Ask User cleanup guarantee; unresolved foreign cancellation blocks later MCP form use across runtime replacement. This capability adds no approval-policy engine and does not change the existing authenticated child-question relay.

## TUI controls

- `Tab` or `←`/`→`: move between questions and Review.
- `↑`/`↓`: move through choices.
- `1`-`4`: directly choose or toggle a numbered choice.
- `Enter`: choose or activate an action.
- `Space`: toggle a focused multi-select choice.
- `n`: add or edit a note for the current question.
- Pi's configured external-editor binding: edit a text answer, custom answer, or note externally.
- `b`: hide the questionnaire without losing state.
- `/ask-user` or activity Resume: resume a hidden questionnaire.
- `Esc`: leave an editor or cancel the questionnaire.

Text questions open directly in the editor on first entry. While editing, letters such as `b` and `q` and digits are literal text; `Shift+Enter` inserts a newline. `Esc` returns to the question view, where `Enter` activates Edit answer. Unsaved text survives that navigation and hide/resume, but only a valid saved answer counts toward submission. Tabs, notes, hide, and cancellation are available outside the editor. Answers still require explicit submission on Review.

The overlay shows question/answer progress, live text limits, mode-specific controls, and the selected count for multi-select questions. Review highlights unanswered questions; activating the primary review action jumps to the next unanswered item before submission.

## Mode behavior

| Mode  | Behavior                                                                              |
| ----- | ------------------------------------------------------------------------------------- |
| TUI   | Blocking and async tools; full overlay, previews, notes, hide/resume, external editor |
| RPC   | Native answer, optional-note, and review/edit/submit/cancel dialogs                   |
| JSON  | Tool omitted                                                                          |
| Print | Tool omitted                                                                          |

RPC hosts cannot show Pi's custom overlay, so tabs, collapse, external editing, and side-by-side preview layout are TUI-only. RPC text questions open a bounded native input directly, followed by the same optional-note and review/edit flow. RPC uses interruption-linked native dialogs, includes bounded preview text in question titles, and offers an optional bounded note after each answer. Multi-select questions first ask whether to choose listed options or write a custom answer; the listed path accepts only in-range choice numbers and re-prompts invalid input. A final native review shows sanitized answer summaries and lets the user submit, edit any answer, or cancel. Cancellation always discards every answer and note draft.

## Compact tool cards

All three questionnaire tools opt into the shared `pi-code-previews` compact setting. The default `preview` style is unchanged. With `toolCallCollapsedStyle: "compact"` and after `/reload`, submitted results show an answer count; expansion restores the answers. Text answers, custom answers, and notes never appear in compact headlines. Cancellation keeps its original details and never means approval. Live transcript cards show question titles and counts without changing the separate questionnaire overlay. Known queued or pending results show request IDs and visible await guidance, never an answer or approval. Opening failures and unrecognized replies keep their existing cards. Automatic delivery failures keep status/await recovery guidance visible. Dialogs and automatic answer messages are unchanged.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter pi-ask-user typecheck
pnpm --filter pi-ask-user test
pnpm --filter pi-ask-user effect:diagnostics
```

Try it locally with:

```bash
pi -e ./packages/pi-ask-user
```
