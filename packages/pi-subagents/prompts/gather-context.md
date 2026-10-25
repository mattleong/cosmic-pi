---
description: Gather context with scout and researcher subagents, then ask only the questions that remain
argument-hint: "[task]"
---

Prepare to implement this task, but don't implement it yet: ${@:-the task we have been discussing}

1. Start bounded context-gathering subagents with `agent_start`, and ask each one to also list open questions that would change the implementation:
   - One or more `scout`s, each with a distinct slice: the paths and symbols to start from, what to map (existing patterns, entry points, tests, constraints, integration points), and a request for a compact evidence-based map.
   - A `researcher` only when external facts matter, such as third-party APIs, current versions, or standards. Give it focused questions and ask for sources and gaps.
2. `agent_await` their reports, and answer questions with `agent_send`. Check claims that the plan will rest on.
3. Synthesize what is now known: the relevant code, constraints, and the likely approach.
4. Ask me only the questions that remain material to the implementation, those whose answers would change what gets built. Drop questions the findings already answer. Use the `ask_user` tool if it is available, with concrete choices where possible; otherwise ask in a short numbered list.

Don't start implementing until I have answered.
