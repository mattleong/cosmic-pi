# pi-ask-user

Structured, responsive questionnaires for [pi](https://github.com/earendil-works/pi-mono). The `ask_user` agent tool batches one to four decisions into one dialog instead of making the model guess or interrupting repeatedly.

## Install

```bash
pi install npm:pi-ask-user
```

Restart pi after installation. If another questionnaire extension is installed, disable it so the model sees only one ask-user tool.

## What it does

- Single- and multi-select questions with stable returned values.
- An automatic custom-answer action for every question.
- Optional notes that do not change the selected answer.
- Markdown previews beside choices on wide terminals and stacked below them on narrow terminals.
- A review step before answers are submitted.
- RPC fallback through Pi's native `select` and `input` dialogs.
- No tool registration in JSON or print modes where a user cannot answer.

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

Limits are intentionally bounded: 1-4 questions and 2-4 choices per question. Question keys and choice values must be unique in their scope.

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

## TUI controls

- `Tab` or `←`/`→`: move between questions and Review.
- `↑`/`↓`: move through choices.
- `1`-`4`: directly choose or toggle a numbered choice.
- `Enter`: choose or activate an action.
- `Space`: toggle a focused multi-select choice.
- `n`: add or edit a note for the current question.
- Pi's configured external-editor binding: edit a custom answer or note externally.
- `b`: hide the questionnaire without losing state.
- `/ask-user`: resume a hidden questionnaire.
- `Esc`: leave an editor or cancel the questionnaire.

The overlay shows question/answer progress, live text limits, mode-specific controls, and the selected count for multi-select questions. Review highlights unanswered questions; activating the primary review action jumps to the next unanswered item before submission.

## Mode behavior

| Mode  | Behavior                                                               |
| ----- | ---------------------------------------------------------------------- |
| TUI   | Full tabbed overlay, previews, notes, collapse/resume, external editor |
| RPC   | Sequential native select/input dialogs                                 |
| JSON  | Tool omitted                                                           |
| Print | Tool omitted                                                           |

RPC hosts cannot show Pi's custom overlay, so tabs, notes, collapse, and side-by-side preview layout are TUI-only. Bounded preview text is included in the native dialog title.

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
