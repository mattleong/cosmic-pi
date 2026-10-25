---
description: Review a change with parallel reviewer subagents, then triage their findings
argument-hint: "[target or focus]"
---

Review this target with parallel reviewer subagents: ${@:-the uncommitted changes in the working tree}

1. Read the target yourself first: the diff, files, plan, or link it names, plus the relevant project instructions. Note the intent of the change.
2. Choose 2-3 review angles that are distinct and specific to this change, such as correctness and regressions, tests and validation, simplicity, security, concurrency, or API and documentation contracts. Prefer a few sharp angles over many vague ones.
3. Start one `reviewer` per angle in a single `agent_start` call, in fresh context. Make each task self-contained: the exact paths or diff command, the scope, the angle and what to check for it, and the relevant constraints. Ask for evidence-backed findings with file and line references, ranked P0/P1/P2, and a final verdict. Reviewers must not edit files.
4. While they run, do your own narrow inspection if useful. Then `agent_await` the reports. Use `agent_send` to answer a reviewer's question.
5. Verify each finding against the code before accepting it, and synthesize:
   - **Fix now**: concrete issues worth fixing in this change.
   - **Optional**: real but non-blocking improvements.
   - **Rejected**: findings that are wrong, out of scope, or not worth the cost, each with a short reason.

Don't apply every suggestion. Unless I already asked you to fix review findings, present the synthesis and ask before editing.
