# pi-ask-user

Structured questionnaires that let the agent ask you for decisions instead of guessing. One dialog batches up to six questions, with previews, notes, and a review step before anything is submitted.

## Features

- **Blocking or async.** `ask_user` waits for your answers. In the TUI, `ask_user_async` opens the same dialog while the agent continues work that doesn't depend on them.
- **Three question types:** single choice, multiple choice, and required free text. Choice questions always offer a custom answer, and any question can carry an optional note.
- **Markdown previews** beside choices on wide terminals, stacked below them on narrow ones.
- **Review before submit**, with unanswered questions highlighted.
- **Hide and resume** without losing drafts, from `/ask-user` or the Cosmic UI Activity view.
- **Subagent questions** from local Pi children appear in the root session under the agent that asked.
- **Private forms** for other local extensions through `pi-ask-user/protocol`.

## Install

```bash
pi install npm:pi-ask-user
```

Restart Pi afterwards. If another questionnaire extension is installed, disable it so the model sees only one ask-user tool.

## Usage

The agent calls the tools and you answer in the overlay. A typical call:

```json
{
  "questions": [
    {
      "key": "library",
      "title": "Library",
      "prompt": "Which date library should we use?",
      "mode": "single",
      "choices": [
        { "value": "date-fns", "label": "date-fns" },
        { "value": "luxon", "label": "Luxon", "description": "Richer timezone support." }
      ]
    }
  ]
}
```

- Each call takes 1–6 questions, with 2–4 choices per choice question. Use `mode: "text"` without `choices` for a free-text answer.
- Results return stable `values` alongside their labels. Cancelling returns no answers and never means approval.
- `ask_user_async` also requires `independentWork` and `blockedWork` descriptions. `ask_user_async_control` can `status`, `await`, or `cancel` a pending request.
- Questionnaires must never collect passwords, API keys, or other credentials.

| Key               | Action                              |
| ----------------- | ----------------------------------- |
| `Tab`, `←`/`→`    | Move between questions and Review   |
| `↑`/`↓`, `1`–`4`  | Move through or pick choices        |
| `Enter` / `Space` | Choose / toggle a multi-select item |
| `n`               | Add or edit a note                  |
| `b`               | Hide the questionnaire              |
| `Esc`             | Leave an editor or cancel           |

Pi's external-editor binding edits long answers and notes outside the dialog.

## How it works

Every questionnaire, async request, child question, and extension form shares one FIFO queue, so only one dialog is shown at a time. Async answers reach the agent as a steering message, or go straight to a caller that is already awaiting them. RPC sessions fall back to Pi's native `select` and `input` dialogs; JSON and print modes don't register the tools. The extension makes no model calls and stores answers only in Pi's session history.

See [docs/reference.md](docs/reference.md) for the full tool contract, limits, delivery semantics, and forms protocol, and [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
