# pi-ask-user reference

Detailed tool contracts and behavior behind the [README](../README.md). [ARCHITECTURE.md](../ARCHITECTURE.md) owns queueing, delivery, retention, lifecycle, and rendering internals; this file links to it rather than repeating them.

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

Question keys and choice values must be unique in their scope.

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

Cancellation returns `{ "outcome": "cancelled", "answers": [] }`.

## Async questionnaires

`ask_user_async` accepts the same `questions` array plus two required, nonblank descriptions, each limited to 500 characters:

- `independentWork`: useful work the agent can do without the answers.
- `blockedWork`: decisions or work that must wait for the answers.

With no earlier questionnaire, the tool opens and focuses the overlay and returns a pending `requestId` and stable `deliveryId` once it is mounted. Otherwise it returns `presentation: queued` immediately, and the overlay opens automatically when earlier questionnaires and unrelated prompts close. The agent should then do only the declared independent work. Use blocking `ask_user` when no such work exists.

`ask_user_async_control` supports:

```json
{ "action": "status" }
{ "action": "status", "requestId": "<returned ID>" }
{ "action": "await", "requestId": "<returned ID>" }
{ "action": "cancel", "requestId": "<returned ID>" }
```

`status` without an ID lists retained metadata; with an ID it returns the full result. Use `await` when independent work is exhausted, not repeated status polling. A full questionnaire queue rejects admission.

Answer delivery, waiter ownership, retention, retries, and the shared queue are described in [ARCHITECTURE.md](../ARCHITECTURE.md#async-ownership-and-delivery); revocation and history receipts across reload, replacement, and tree navigation are in [its session lifecycle section](../ARCHITECTURE.md#session-lifecycle-and-history).

## Activity view and child questions

In the Cosmic UI Activity view, Resume closes the manager first so the questionnaire gets keyboard focus, while Cancel runs with the manager open. Run cancellation or session replacement cancels a child's waiting or mounted requests. Activity rows, hide/resume, and the authenticated child relay are described in [ARCHITECTURE.md](../ARCHITECTURE.md#tui-lifecycle-and-pinned-host-workaround).

## TUI controls

While editing a text answer, letters such as `b` and `q` and digits are literal text; `Shift+Enter` inserts a newline. `Esc` returns to the question view, where `Enter` activates Edit answer. Only a valid saved answer counts toward submission, and answers still require explicit submission on Review.

The overlay shows question/answer progress, live text limits, mode-specific controls, and the selected count for multi-select questions. Activating the primary review action jumps to the next unanswered item before submission.

## RPC behavior

RPC hosts cannot show Pi's custom overlay, so tabs, collapse, external editing, and side-by-side preview layout are TUI-only. RPC text questions open a bounded native input directly, followed by the same optional-note and review/edit flow. RPC includes bounded preview text in question titles. Multi-select questions first ask whether to choose listed options or write a custom answer; the listed path re-prompts invalid input. The final native review shows sanitized answer summaries.

## Transcript cards

All three questionnaire tools use the shared `pi-code-previews` tool shell and follow its `toolCallCollapsedStyle`: `preview` by default, or `compact` after `/reload`. Both styles, their issue wording, and expanded views are described in [ARCHITECTURE.md](../ARCHITECTURE.md#modes-security-and-rendering).
