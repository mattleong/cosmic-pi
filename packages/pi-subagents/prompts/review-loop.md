---
description: Implement or take a change, then review and fix it in a capped loop
argument-hint: "[change to implement or review]"
---

Run a review loop on this work: ${@:-the uncommitted changes in the working tree}

You stay in control of the loop and make the final decisions. Subagents get concrete, self-contained tasks and don't manage the loop.

1. **Implement.** If the request asks for new work, implement it yourself or start one `worker` with `agent_start` and a self-contained task, then `agent_await` it. If the change already exists, start reviewing.
2. **Review.** Start a fresh-context `reviewer` with `agent_start`. Give it the exact diff or paths, the intent of the change, and the relevant constraints. Ask for evidence-backed findings caused by this change, with file and line references, ranked P0 (blocks merging), P1 (fix before release), or P2 (worth noting). `agent_await` the report.
3. **Triage.** Verify each finding against the code. Approve only real fixes worth doing now; record rejected or deferred findings with a short reason. If a finding needs a product, scope, or architecture decision, stop and ask me.
4. **Fix.** Apply only the approved fixes, yourself or through one `worker`, and run focused validation. Keep a single writer on the checkout at a time.
5. **Repeat** from step 2 only when the fixes were material. A follow-up review checks whether each fixed finding is resolved and whether the fixes introduced new defects.

Stop when any of these holds:

- no P0 or P1 findings remain;
- remaining feedback is optional, speculative, or deferred;
- a decision needs me;
- 3 review rounds have run. Report what remains unresolved.

Finish with your own final check: read the final diff, run or confirm the relevant validation, and summarize the rounds run, fixes applied, validation results, deferred items, and why the loop stopped.
