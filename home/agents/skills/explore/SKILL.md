---
name: explore
description: Run the Trinket prompt.report workflow to define a problem, select analytical lenses, compare approaches and identify a useful next check. Use for /explore.
argument-hint: "[request]"
---

# Problem-definition report

Use the text after /explore as the request. For a bare invocation, use the substantive request the user is currently discussing. If several requests are plausible, ask which one. Include relevant constraints or prior answers from the conversation as attributed context. Preserve uncertainties and distinguish the user's words from inferences.

Call the installed Trinket MCP tool `prompt.report` with the request as its text `input`. When MCP is unavailable, save the request literally to a temporary UTF-8 file and call `trinket run prompt.report <file> --json`. Wait for that run to finish. Read the final `report` artifact and present it or link the full Markdown with a concise summary. If it fails, report the run ID and actual failure.
