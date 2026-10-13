# Agent guidance for pi-better-openai

Follow the [workspace guidance](../../AGENTS.md). Read
[ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle before changing a
service or integration boundary. Its source links describe the current design;
they are not a required directory template.

- Keep configuration authority separate from usage, fast mode, images, and
  compaction. Preserve unknown JSON fields when writing settings.
- Recheck originating-session authority beside delayed host actions. Retired
  commands, image definitions, and durable commits must not publish into a new
  session.
- Preserve complete transcript reconstruction and safe native fallback when
  changing compaction. Disabling provider compaction does not remove the need to
  interpret existing owned checkpoints.
- Keep image input paths workspace-contained, file cleanup identity-checked, and
  decoder reuse conditional on confirmed child exit. Test changes to those
  boundaries through the existing owned seams.
- Obtain credentials through Pi's model registry. Never expose auth contents or
  account IDs in diagnostics or examples.

Use the existing TypeScript ESM `.ts` imports. For code changes, run the relevant
package tests followed by the workspace validation gate from the repository root:

```bash
pnpm --filter pi-better-openai test
pnpm validate
```
