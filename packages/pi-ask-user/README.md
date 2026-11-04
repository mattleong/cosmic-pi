# pi-ask-user

Structured questionnaires that let the agent ask you for decisions instead of guessing. One dialog batches up to six questions, with previews, notes, and a review step before anything is submitted; a single question submits as soon as you answer it.

## Features

- **Blocking or async.** `ask_user` waits for your answers. In the TUI, `ask_user_async` opens the same dialog while the agent continues work that doesn't depend on them.
- **Three question types:** single choice, multiple choice, and required free text. Choice questions always offer a custom answer, and any question can carry an optional note.
- **Markdown previews** beside choices on wide terminals, stacked below them on narrow ones.
- **Review before submit** for several questions, with unanswered questions highlighted. A single question skips the review step: choosing an answer submits it.
- **Hide and resume** without losing drafts, from `/ask-user` or the Cosmic UI Activity view.
- **Subagent questions** from local Pi children appear in the root session under the agent that asked.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-ask-user"
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
        { "value": "date-fns", "label": "date-fns", "description": "Small functional helpers." },
        { "value": "luxon", "label": "Luxon", "description": "Richer timezone support." }
      ]
    }
  ]
}
```

- Each call takes 1–6 questions, with 2–6 choices per choice question. Use `mode: "text"` without `choices` for a free-text answer; empty `choices` is ignored.
- Results return stable `values` alongside their labels. Cancelling returns no answers and never means approval.
- `ask_user_async` also requires `independentWork` and `blockedWork` descriptions. `ask_user_async_control` can `status`, `await`, or `cancel` a pending request.
- Questionnaires must never collect passwords, API keys, or other credentials.

| Key                   | Action                                                                  |
| --------------------- | ----------------------------------------------------------------------- |
| `↑`/`↓`, `j`/`k`      | Move through choices                                                    |
| `Enter`, `1`–`6`      | Choose; with a single question, choose and submit                       |
| `Space`               | Toggle a multi-select item                                              |
| `←`/`→`, `Tab`/`⇧Tab` | Move between questions and Review (several questions only)              |
| `n`                   | Add or edit a note                                                      |
| `b`                   | Hide the questionnaire; `/ask-user` or Activity → Resume brings it back |
| `?`                   | Show more keys                                                          |
| `Esc`                 | Leave an editor, or cancel the questionnaire                            |

Pi's external-editor binding (`Ctrl+G` by default) edits long answers and notes outside the dialog.

## How it works

Every questionnaire, async request, and child question shares one FIFO queue, so only one dialog is shown at a time. Async answers reach the agent as a steering message, or go straight to a caller that is already awaiting them. RPC sessions fall back to Pi's native `select` and `input` dialogs; JSON and print modes don't register the tools. The extension makes no model calls and stores answers only in Pi's session history.

See [docs/reference.md](docs/reference.md) for the full tool contract, limits, and delivery semantics, and [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
