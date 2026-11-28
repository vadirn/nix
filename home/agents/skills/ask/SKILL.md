---
name: ask
description: Use /ask to clarify the current request across turns with Trinket prompt.ask, reusing settled answers and surfacing remaining questions.
---

# Ask

Call the conversation-aware Trinket MCP tool `prompt.ask` with empty arguments. The local stdio bridge supplies the current conversation and history. Poll `get_run_status` and read the decision with `read_run_output`. Present its open questions, or report that the subject is ready. After the user answers, a later /ask continues from that evidence. If the bridge is unavailable, identify the missing connection.

Use /probe when the user wants a critique of a chosen plan with recommended answers.
