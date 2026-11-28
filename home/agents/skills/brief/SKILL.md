---
name: brief
description: Use /brief to compile the current conversation’s settled decisions, required inputs, next action and acceptance check with Trinket prompt.brief.
---

# Brief

Call the conversation-aware Trinket MCP tool `prompt.brief` with empty arguments. The local stdio bridge supplies the conversation and its settled probe history when available. Poll `get_run_status` and read the output with `read_run_output`. Present the published brief and its run ID. If the decision has open questions, ask them. If the workflow returns review-needed, report why it withheld publication. If the bridge is unavailable, identify the missing connection.

Use /brief when the assignment still needs to be compiled. Use /handoff brief when passing an assignment to a worker. Given a published brief, /handoff brief carries it verbatim and honors its requested return format.
